use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

const LOG_NAME: &str = "desktop-sidecar.log";
const MAX_BYTES: u64 = 256 * 1024;
const ROTATIONS: usize = 3;

#[derive(Clone)]
pub(crate) struct SidecarLog {
    inner: Arc<Mutex<Option<LogWriter>>>,
}

struct LogWriter {
    path: PathBuf,
    file: Option<File>,
    max_bytes: u64,
    rotations: usize,
}

impl SidecarLog {
    pub(crate) fn open() -> io::Result<Self> {
        let directory = dirs::home_dir()
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "home directory unavailable"))?
            .join(".warpforge")
            .join("logs");
        Self::open_in(&directory, MAX_BYTES, ROTATIONS)
    }

    pub(crate) fn disabled() -> Self {
        Self {
            inner: Arc::new(Mutex::new(None)),
        }
    }

    #[cfg(test)]
    pub(crate) fn is_disabled(&self) -> bool {
        self.inner
            .lock()
            .map(|inner| inner.is_none())
            .unwrap_or(true)
    }

    fn open_in(directory: &Path, max_bytes: u64, rotations: usize) -> io::Result<Self> {
        create_private_directory(directory)?;
        let path = directory.join(LOG_NAME);
        let file = open_private_append(&path)?;
        Ok(Self {
            inner: Arc::new(Mutex::new(Some(LogWriter {
                path,
                file: Some(file),
                max_bytes,
                rotations,
            }))),
        })
    }

    pub(crate) fn lifecycle(&self, message: &str) {
        self.write("lifecycle", message);
    }

    pub(crate) fn stderr(&self, bytes: &[u8]) {
        let text = String::from_utf8_lossy(bytes);
        self.write("stderr", &redact(&text));
    }

    pub(crate) fn error(&self, message: &str) {
        self.write("error", &redact(message));
    }

    fn write(&self, kind: &str, message: &str) {
        let Ok(mut guard) = self.inner.lock() else {
            eprintln!("warning: sidecar log lock was poisoned");
            return;
        };
        let Some(writer) = guard.as_mut() else {
            eprintln!("warpforge: [{kind}] {message}");
            return;
        };
        if let Err(error) = writer.write(kind, message) {
            eprintln!("warning: could not write sidecar log: {error}");
        }
    }
}

impl LogWriter {
    fn write(&mut self, kind: &str, message: &str) -> io::Result<()> {
        let clean = sanitize(message);
        let line = format!("{} [{kind}] {clean}\n", timestamp());
        if self
            .file
            .as_ref()
            .ok_or_else(|| io::Error::other("sidecar log file is unavailable"))?
            .metadata()?
            .len()
            .saturating_add(line.len() as u64)
            > self.max_bytes
        {
            self.rotate()?;
        }
        let file = self
            .file
            .as_mut()
            .ok_or_else(|| io::Error::other("sidecar log file is unavailable"))?;
        file.write_all(line.as_bytes())?;
        file.flush()
    }

    fn rotate(&mut self) -> io::Result<()> {
        if let Some(mut file) = self.file.take() {
            file.flush()?;
        }
        for index in (1..=self.rotations).rev() {
            let source = if index == 1 {
                self.path.clone()
            } else {
                rotated_path(&self.path, index - 1)
            };
            let destination = rotated_path(&self.path, index);
            if source.exists() {
                if destination.exists() {
                    fs::remove_file(&destination)?;
                }
                fs::rename(source, destination)?;
            }
        }
        self.file = Some(open_private_truncate(&self.path)?);
        Ok(())
    }
}

fn rotated_path(path: &Path, index: usize) -> PathBuf {
    PathBuf::from(format!("{}.{}", path.display(), index))
}

fn timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn sanitize(message: &str) -> String {
    message
        .chars()
        .map(|character| match character {
            '\n' | '\r' | '\t' => ' ',
            character if character.is_control() => '�',
            character => character,
        })
        .take(4096)
        .collect::<String>()
        .trim()
        .to_string()
}

fn redact(message: &str) -> String {
    let mut words: Vec<String> = message.split_whitespace().map(str::to_string).collect();
    let mut redact_next = false;
    for word in &mut words {
        let lower = word.to_ascii_lowercase();
        if redact_next {
            *word = "[REDACTED]".to_string();
            redact_next = is_sensitive_label(&lower);
            continue;
        }
        if is_sensitive_label(&lower) {
            redact_next = true;
            continue;
        }
        if let Some(separator) = sensitive_separator(word) {
            let has_inline_value = word[separator + 1..]
                .chars()
                .any(|character| character.is_ascii_alphanumeric());
            word.truncate(separator + 1);
            word.push_str("[REDACTED]");
            redact_next = !has_inline_value;
        }
    }
    words.join(" ")
}

fn is_sensitive_label(word: &str) -> bool {
    matches!(
        word.trim_matches(|character: char| !character.is_ascii_alphanumeric() && character != '_'),
        "bearer"
            | "token"
            | "auth"
            | "auth_token"
            | "authorization"
            | "access_token"
            | "api_key"
            | "apikey"
            | "password"
            | "secret"
            | "cookie"
            | "set_cookie"
            | "session"
            | "session_id"
    )
}

fn sensitive_separator(word: &str) -> Option<usize> {
    word.char_indices().find_map(|(index, character)| {
        if !matches!(character, '=' | ':') {
            return None;
        }
        let key = word[..index]
            .trim_end_matches(|character: char| {
                !character.is_ascii_alphanumeric() && character != '_'
            })
            .rsplit(|character: char| !character.is_ascii_alphanumeric() && character != '_')
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        (key.contains("token")
            || key.contains("password")
            || key.contains("secret")
            || key.contains("cookie")
            || key.contains("session")
            || matches!(key.as_str(), "authorization" | "auth" | "api_key" | "apikey"))
        .then_some(index)
    })
}

fn create_private_directory(path: &Path) -> io::Result<()> {
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn open_private_append(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    configure_private_mode(&mut options);
    let file = options.open(path)?;
    enforce_private_file(&file)?;
    Ok(file)
}

fn open_private_truncate(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.create(true).write(true).truncate(true);
    configure_private_mode(&mut options);
    let file = options.open(path)?;
    enforce_private_file(&file)?;
    Ok(file)
}

fn configure_private_mode(options: &mut OpenOptions) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
}

fn enforce_private_file(file: &File) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_directory(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "warpforge-sidecar-log-{name}-{}-{}",
            std::process::id(),
            timestamp()
        ))
    }

    #[test]
    fn redacts_auth_values() {
        let text = redact(
            "authorization: Bearer secret auth_token=abc token:xyz access_token=q auth nope api_key=sk-live password=hunter2 cookie=session-cookie session_id=sid https://localhost/?token=url-secret {\"auth_token\":\"json-secret\"}",
        );
        assert!(!text.contains("secret"));
        assert!(!text.contains("abc"));
        assert!(!text.contains("xyz"));
        assert!(!text.contains("=q"));
        assert!(!text.contains("nope"));
        assert!(!text.contains("sk-live"));
        assert!(!text.contains("hunter2"));
        assert!(!text.contains("session-cookie"));
        assert!(!text.contains("sid"));
        assert!(!text.contains("url-secret"));
        assert!(!text.contains("json-secret"));
        assert!(text.contains("[REDACTED]"));
    }

    #[test]
    fn rotates_at_the_bound_and_keeps_a_fixed_number_of_files() {
        let directory = test_directory("rotation");
        let log = SidecarLog::open_in(&directory, 70, 2).unwrap();
        for index in 0..10 {
            log.lifecycle(&format!("event-{index}-with-padding"));
        }
        drop(log);

        assert!(directory.join(LOG_NAME).exists());
        assert!(rotated_path(&directory.join(LOG_NAME), 1).exists());
        assert!(rotated_path(&directory.join(LOG_NAME), 2).exists());
        assert!(!rotated_path(&directory.join(LOG_NAME), 3).exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(directory.join(LOG_NAME))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn disabled_logger_does_not_panic_on_any_operation() {
        let log = SidecarLog::disabled();
        assert!(log.is_disabled());

        log.lifecycle("startup continuing without file logging");
        log.stderr(b"child process stderr: something happened");
        log.error("non-fatal error in sidecar stream");
        log.lifecycle("daemon terminated (code=Some(1), signal=None)");
    }

    #[test]
    fn open_in_unwritable_path_yields_err_without_panic() {
        let bogus = PathBuf::from("/dev/null/impossible-nested-path");
        let result = SidecarLog::open_in(&bogus, MAX_BYTES, ROTATIONS);
        assert!(result.is_err());

        let log = SidecarLog::disabled();
        assert!(log.is_disabled());
        log.lifecycle("continuing after failed log init");
        log.error("captured but not fatal");
    }
}
