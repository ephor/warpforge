#[cfg(any(test, all(unix, not(debug_assertions))))]
use std::ffi::{OsStr, OsString};

/// Build the PATH passed to the packaged sidecar. Desktop launchers commonly
/// provide only a system PATH, while the user's interactive shell initializes
/// package managers and agent binaries.
#[cfg(all(unix, not(debug_assertions)))]
pub(crate) fn sidecar_path() -> Result<OsString, String> {
    let inherited = std::env::var_os("PATH").unwrap_or_default();
    let shell_path = interactive_shell_path()?;
    merge_paths(&shell_path, &inherited)
}

#[cfg(all(unix, not(debug_assertions)))]
fn interactive_shell_path() -> Result<OsString, String> {
    use std::io::Read;
    use std::os::unix::ffi::OsStringExt;
    use std::process::{Command, Stdio};
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    const BEGIN: &[u8] = b"\x1eWARPFORGE_PATH_BEGIN\x1f";
    const END: &[u8] = b"\x1eWARPFORGE_PATH_END\x1f";
    const MAX_OUTPUT: usize = 256 * 1024;

    let shell = std::env::var_os("SHELL")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| OsString::from("/bin/sh"));
    let script = "printf '\\036WARPFORGE_PATH_BEGIN\\037%s\\036WARPFORGE_PATH_END\\037' \"$PATH\"";
    let mut child = Command::new(&shell)
        .args(["-ilc", script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("could not run login shell {shell:?}: {error}"))?;

    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "login shell stdout was unavailable".to_string())?;
    let (sender, receiver) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout
            .by_ref()
            .take((MAX_OUTPUT + 1) as u64)
            .read_to_end(&mut bytes)
            .map(|_| bytes);
        let _ = sender.send(result);
    });

    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return Err(format!("login shell {shell:?} exited with {status}"));
                }
                break;
            }
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("login shell {shell:?} timed out after 3 seconds"));
            }
            Err(error) => return Err(format!("could not wait for login shell {shell:?}: {error}")),
        }
    }

    let output = receiver
        .recv_timeout(Duration::from_millis(250))
        .map_err(|_| "login shell output did not close promptly".to_string())?
        .map_err(|error| format!("could not read login shell output: {error}"))?;
    if output.len() > MAX_OUTPUT {
        return Err("login shell produced excessive startup output".to_string());
    }
    let path = parse_framed_path(&output, BEGIN, END)?;
    if path.is_empty() {
        return Err("login shell returned an empty PATH".to_string());
    }
    Ok(OsString::from_vec(path.to_vec()))
}

#[cfg(any(test, all(unix, not(debug_assertions))))]
fn merge_paths(preferred: &OsStr, inherited: &OsStr) -> Result<OsString, String> {
    let mut paths = Vec::new();
    for path in std::env::split_paths(preferred).chain(std::env::split_paths(inherited)) {
        if !path.as_os_str().is_empty() && !paths.iter().any(|existing| existing == &path) {
            paths.push(path);
        }
    }
    std::env::join_paths(paths).map_err(|error| format!("could not merge PATH entries: {error}"))
}

#[cfg(any(test, all(unix, not(debug_assertions))))]
fn parse_framed_path<'a>(output: &'a [u8], begin: &[u8], end: &[u8]) -> Result<&'a [u8], String> {
    let start = output
        .windows(begin.len())
        .rposition(|window| window == begin)
        .map(|index| index + begin.len())
        .ok_or_else(|| "login shell output did not contain the PATH marker".to_string())?;
    let finish = output[start..]
        .windows(end.len())
        .position(|window| window == end)
        .map(|index| start + index)
        .ok_or_else(|| "login shell output contained an incomplete PATH marker".to_string())?;
    Ok(&output[start..finish])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merges_shell_path_first_without_dropping_or_duplicating_entries() {
        let preferred = std::env::join_paths([
            "/opt/homebrew/bin",
            "/Users/me/.fnm/current/bin",
            "/usr/bin",
        ])
        .unwrap();
        let inherited =
            std::env::join_paths(["/usr/bin", "/bin", "/Users/me/.opencode/bin"]).unwrap();
        let merged = merge_paths(&preferred, &inherited).unwrap();

        let entries: Vec<_> = std::env::split_paths(&merged).collect();
        assert_eq!(
            entries,
            [
                "/opt/homebrew/bin",
                "/Users/me/.fnm/current/bin",
                "/usr/bin",
                "/bin",
                "/Users/me/.opencode/bin"
            ]
            .map(std::path::PathBuf::from)
        );
    }

    #[test]
    fn parser_ignores_shell_startup_noise_and_uses_last_complete_frame() {
        let begin = b"<begin>";
        let end = b"<end>";
        let output = b"motd\n<begin>stale<end>plugin noise\n<begin>/brew:/nvm<end>trailer";
        assert_eq!(
            parse_framed_path(output, begin, end).unwrap(),
            b"/brew:/nvm"
        );
    }

    #[test]
    fn parser_rejects_missing_or_incomplete_frames() {
        assert!(parse_framed_path(b"noise", b"<b>", b"<e>").is_err());
        assert!(parse_framed_path(b"<b>value", b"<b>", b"<e>").is_err());
    }
}
