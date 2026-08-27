//! Language-server proxy. The daemon spawns real language servers (rust-analyzer,
//! typescript-language-server, …) and tunnels their stdio to editor clients over
//! the WebSocket. Payloads stay opaque JSON — the daemon frames LSP messages
//! (`Content-Length` headers) but never interprets their semantics.
//!
//! Servers are lazy and shared: one process per (workspace root, language),
//! reference-counted across open editors and killed once the last editor closes
//! (`kill_on_drop`). A missing server binary is not an error — `start` reports
//! `available: false` and the editor falls back to syntax-only mode.

use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout, Command};
use tokio::sync::{broadcast, mpsc};
use uuid::Uuid;

use super::actor::Event;

/// Map an editor language id to its language-server command. Returns `None` when
/// warpforge does not know a server for that language (e.g. markdown).
fn server_command(language: &str, root: &str) -> Option<(String, Vec<String>)> {
    match language {
        "rust" => Some(command("rust-analyzer", &[])),
        "typescript" | "javascript" => Some(typescript_server_command(root)),
        "go" => Some(command("gopls", &[])),
        "python" => Some(command("pyright-langserver", &["--stdio"])),
        "json" => Some(command("vscode-json-language-server", &["--stdio"])),
        "css" => Some(command("vscode-css-language-server", &["--stdio"])),
        "html" => Some(command("vscode-html-language-server", &["--stdio"])),
        "yaml" => Some(command("yaml-language-server", &["--stdio"])),
        "elixir" => Some(elixir_server_command()),
        _ => None,
    }
}

fn command(bin: &str, args: &[&str]) -> (String, Vec<String>) {
    (
        bin.to_string(),
        args.iter().map(|arg| (*arg).to_string()).collect(),
    )
}

/// TypeScript 7 is the native Go implementation and exposes LSP directly.
/// Older TypeScript releases expose the legacy tsserver protocol and need the
/// `typescript-language-server` adapter. Prefer the project's local TypeScript
/// binary so a TS7 workspace is not accidentally paired with unrelated global
/// TypeScript.
fn typescript_server_command(root: &str) -> (String, Vec<String>) {
    let local_tsc = Path::new(root).join("node_modules/.bin/tsc");
    if let Some(version) = typescript_version(&local_tsc) {
        if version >= 7 {
            return command(&local_tsc.to_string_lossy(), &["--lsp", "--stdio"]);
        }
        return local_typescript_adapter(root);
    }

    if let Some(command) = native_typescript_command(Path::new("tsc")) {
        return command;
    }

    local_typescript_adapter(root)
}

fn local_typescript_adapter(root: &str) -> (String, Vec<String>) {
    let local_adapter = Path::new(root).join("node_modules/.bin/typescript-language-server");
    if local_adapter.exists() {
        return command(&local_adapter.to_string_lossy(), &["--stdio"]);
    }
    command("typescript-language-server", &["--stdio"])
}

fn native_typescript_command(bin: &Path) -> Option<(String, Vec<String>)> {
    typescript_version(bin)
        .filter(|major| *major >= 7)
        .map(|_| command(&bin.to_string_lossy(), &["--lsp", "--stdio"]))
}

fn typescript_version(bin: &Path) -> Option<u32> {
    std::process::Command::new(bin)
        .arg("--version")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .and_then(|version| typescript_major(&version))
}

fn typescript_major(version: &str) -> Option<u32> {
    version
        .split_whitespace()
        .find_map(|part| part.split('.').next()?.parse().ok())
}

fn elixir_server_command() -> (String, Vec<String>) {
    // Prefer elixir-ls (homebrew/core: `brew install elixir-ls` -> binary `elixir-ls`).
    // lexical has no homebrew/core formula (must build from source), nextls is
    // deprecated and requires tap `elixir-tools/tap/next-ls`.
    for (bin, args) in [
        ("elixir-ls", &[] as &[&str]),
        ("lexical", &[]),
        ("nextls", &["--stdio"]),
    ] {
        if binary_exists(bin) {
            return command(bin, args);
        }
    }
    command("elixir-ls", &[])
}

fn binary_exists(bin: &str) -> bool {
    std::process::Command::new(bin)
        .arg("--help")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .is_ok()
}

struct ServerHandle {
    stdin_tx: mpsc::UnboundedSender<Vec<u8>>,
    key: (String, String),
    refs: usize,
    /// Kept alive to hold the process; dropping it kills the server.
    _child: tokio::process::Child,
}

pub struct LspManager {
    event_tx: broadcast::Sender<Event>,
    servers: HashMap<String, ServerHandle>,
    by_key: HashMap<(String, String), String>,
}

impl LspManager {
    pub fn new(event_tx: broadcast::Sender<Event>) -> Self {
        Self {
            event_tx,
            servers: HashMap::new(),
            by_key: HashMap::new(),
        }
    }

    /// Ensure a server for `(root, language)` is running. Returns its id and
    /// whether a server binary was available. Reuses an existing process.
    pub fn start(&mut self, root: String, language: String) -> (String, bool) {
        let key = (root.clone(), language.clone());
        if let Some(id) = self.by_key.get(&key).cloned() {
            let alive = self
                .servers
                .get_mut(&id)
                .is_some_and(|handle| matches!(handle._child.try_wait(), Ok(None)));
            if alive {
                if let Some(handle) = self.servers.get_mut(&id) {
                    handle.refs += 1;
                    return (id, true);
                }
            } else {
                self.servers.remove(&id);
                self.by_key.remove(&key);
            }
        }

        let Some((bin, args)) = server_command(&language, &root) else {
            return (String::new(), false);
        };

        let mut child = match Command::new(&bin)
            .args(&args)
            .current_dir(&root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
        {
            Ok(child) => child,
            Err(_) => return (String::new(), false), // binary not installed
        };

        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let server_id = Uuid::new_v4().to_string();

        let (stdin_tx, stdin_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        tokio::spawn(write_loop(stdin, stdin_rx));

        let event_tx = self.event_tx.clone();
        let id = server_id.clone();
        tokio::spawn(async move {
            let _ = read_loop(stdout, &id, &event_tx).await;
            let _ = event_tx.send(Event::LspExit {
                server_id: id,
                code: None,
            });
        });

        self.servers.insert(
            server_id.clone(),
            ServerHandle {
                stdin_tx,
                key: key.clone(),
                refs: 1,
                _child: child,
            },
        );
        self.by_key.insert(key, server_id.clone());
        (server_id, true)
    }

    /// Forward an opaque LSP message to a server's stdin.
    pub fn send(&self, server_id: &str, payload: serde_json::Value) {
        if let Some(handle) = self.servers.get(server_id) {
            if let Ok(bytes) = serde_json::to_vec(&payload) {
                let _ = handle.stdin_tx.send(bytes);
            }
        }
    }

    /// Release one editor's reference; kill the process when none remain.
    pub fn stop(&mut self, server_id: &str) {
        let drop_key = match self.servers.get_mut(server_id) {
            Some(handle) => {
                handle.refs = handle.refs.saturating_sub(1);
                if handle.refs == 0 {
                    Some(handle.key.clone())
                } else {
                    None
                }
            }
            None => None,
        };
        if let Some(key) = drop_key {
            self.servers.remove(server_id); // drop → kill_on_drop
            self.by_key.remove(&key);
        }
    }
}

/// Write LSP `Content-Length`-framed messages to a server's stdin.
async fn write_loop(mut stdin: ChildStdin, mut rx: mpsc::UnboundedReceiver<Vec<u8>>) {
    while let Some(bytes) = rx.recv().await {
        let header = format!("Content-Length: {}\r\n\r\n", bytes.len());
        if stdin.write_all(header.as_bytes()).await.is_err()
            || stdin.write_all(&bytes).await.is_err()
            || stdin.flush().await.is_err()
        {
            break;
        }
    }
}

/// Parse LSP framing from a server's stdout and emit each message as an event.
async fn read_loop(
    stdout: ChildStdout,
    server_id: &str,
    event_tx: &broadcast::Sender<Event>,
) -> std::io::Result<()> {
    let mut reader = BufReader::new(stdout);
    loop {
        let mut content_length = 0usize;
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).await? == 0 {
                return Ok(()); // EOF
            }
            let trimmed = line.trim_end();
            if trimmed.is_empty() {
                break; // end of headers
            }
            if let Some(value) = trimmed.strip_prefix("Content-Length:") {
                content_length = value.trim().parse().unwrap_or(0);
            }
        }
        if content_length == 0 {
            continue;
        }
        let mut buf = vec![0u8; content_length];
        reader.read_exact(&mut buf).await?;
        if let Ok(payload) = serde_json::from_slice::<serde_json::Value>(&buf) {
            let _ = event_tx.send(Event::LspMessage {
                server_id: server_id.to_string(),
                payload,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::typescript_major;

    #[test]
    fn parses_typescript_major_versions() {
        assert_eq!(typescript_major("Version 7.0.2\n"), Some(7));
        assert_eq!(typescript_major("Version 5.9.3"), Some(5));
        assert_eq!(typescript_major("unexpected"), None);
    }
}
