#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_shell::{
    process::Command as ShellCommand, process::CommandChild, process::CommandEvent, ShellExt,
};
use warpforge_protocol::DaemonEndpoint;

mod desktop_env;
mod sidecar_log;

use sidecar_log::SidecarLog;

#[cfg(all(unix, not(debug_assertions)))]
fn configure_sidecar_path(command: ShellCommand, log: &SidecarLog) -> ShellCommand {
    match desktop_env::sidecar_path() {
        Ok(path) => {
            log.lifecycle("resolved and merged the login-shell PATH");
            command.env("PATH", path)
        }
        Err(error) => {
            log.error(&format!(
                "could not resolve login-shell PATH; using inherited PATH: {error}"
            ));
            command
        }
    }
}

#[cfg(not(all(unix, not(debug_assertions))))]
fn configure_sidecar_path(command: ShellCommand, _log: &SidecarLog) -> ShellCommand {
    command
}

enum ManagedDaemon {
    Development(Child),
    Sidecar(CommandChild),
}

struct DaemonProcess {
    child: Mutex<Option<ManagedDaemon>>,
}

impl DaemonProcess {
    fn new(child: Option<ManagedDaemon>) -> Self {
        Self {
            child: Mutex::new(child),
        }
    }

    fn pid(&self) -> Option<u32> {
        self.child
            .lock()
            .ok()
            .and_then(|child| match child.as_ref()? {
                ManagedDaemon::Development(child) => Some(child.id()),
                ManagedDaemon::Sidecar(child) => Some(child.pid()),
            })
    }
}

/// Check whether a daemon is already listening by reading daemon.json and
/// attempting a TCP connect to its port. Used to avoid double-spawning.
fn is_daemon_running() -> bool {
    (|| -> Option<bool> {
        let path = dirs::home_dir()?.join(".warpforge").join("daemon.json");
        let text = std::fs::read_to_string(&path).ok()?;
        let ep: serde_json::Value = serde_json::from_str(&text).ok()?;
        // "ws://127.0.0.1:PORT" → "127.0.0.1:PORT"
        let url = ep["url"].as_str()?;
        let addr: std::net::SocketAddr = url.trim_start_matches("ws://").parse().ok()?;
        Some(
            std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(300))
                .is_ok(),
        )
    })()
    .unwrap_or(false)
}

/// Find the warpforge daemon binary.
///
/// Priority:
/// 1. `WARPFORGE_DAEMON_BIN` env var (explicit override)
/// 2. Sibling to current exe (prod app bundle)
/// 3. `workspace/target/debug/warpforge` (Tauri dev layout)
/// 4. `warpforge` on `PATH`
fn find_daemon_bin() -> std::path::PathBuf {
    if let Ok(p) = std::env::var("WARPFORGE_DAEMON_BIN") {
        return p.into();
    }
    if let Ok(exe) = std::env::current_exe() {
        let dir = exe.parent().expect("exe has no parent dir");
        // Prod: warpforge binary bundled next to warpforge-desktop.
        let sibling = dir.join("warpforge");
        if sibling.exists() {
            return sibling;
        }
        // Dev layout: desktop/src-tauri/target/debug/warpforge-desktop
        //   dir = debug/  →  target/  →  src-tauri/  →  desktop/  →  workspace root
        let workspace = dir
            .parent() // target/
            .and_then(|p| p.parent()) // src-tauri/
            .and_then(|p| p.parent()) // desktop/
            .and_then(|p| p.parent()); // workspace root
        if let Some(root) = workspace {
            let dev_bin = root.join("target").join("debug").join("warpforge");
            if dev_bin.exists() {
                return dev_bin;
            }
        }
    }
    "warpforge".into()
}

/// Read daemon.json, retrying for up to 5 s to give the daemon time to start.
#[tauri::command]
fn daemon_endpoint() -> Result<DaemonEndpoint, String> {
    let path = dirs::home_dir()
        .ok_or_else(|| "cannot determine home directory".to_string())?
        .join(".warpforge")
        .join("daemon.json");

    for _ in 0..50 {
        if let Ok(text) = std::fs::read_to_string(&path) {
            let endpoint: DaemonEndpoint =
                serde_json::from_str(&text).map_err(|e| format!("invalid daemon.json: {e}"))?;
            if endpoint.protocol_version != warpforge_protocol::PROTOCOL_VERSION {
                return Err(format!(
                    "incompatible daemon protocol {} (desktop requires {}); stop the running daemon and relaunch Warpforge",
                    endpoint.protocol_version,
                    warpforge_protocol::PROTOCOL_VERSION
                ));
            }
            if endpoint.version != env!("CARGO_PKG_VERSION") {
                return Err(format!(
                    "daemon version {} does not match desktop version {}; stop the running daemon and relaunch Warpforge",
                    endpoint.version,
                    env!("CARGO_PKG_VERSION")
                ));
            }
            return Ok(endpoint);
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }

    Err(format!(
        "daemon not ready — {} not found after 5 s",
        path.display()
    ))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let sidecar_log = match SidecarLog::open() {
                Ok(log) => log,
                Err(error) => {
                    eprintln!("warpforge: could not initialize sidecar log ({error}) — degrading to stderr");
                    SidecarLog::disabled()
                }
            };
            if is_daemon_running() {
                eprintln!("warpforge: daemon already running — reusing");
                sidecar_log.lifecycle("reusing an already-running daemon");
                app.manage(DaemonProcess::new(None));
            } else {
                let explicit_bin = std::env::var_os("WARPFORGE_DAEMON_BIN");
                let spawned = if explicit_bin.is_some() || cfg!(debug_assertions) {
                    let bin = find_daemon_bin();
                    Command::new(&bin)
                        .args(["daemon", "--owner", "desktop"])
                        .spawn()
                        .map(ManagedDaemon::Development)
                        .map_err(|error| format!("could not spawn daemon ({bin:?}): {error}"))
                } else {
                    app.shell()
                        .sidecar("warpforge")
                        .map(|command| configure_sidecar_path(command, &sidecar_log))
                        .map_err(|error| error.to_string())
                        .and_then(|command| {
                            command
                                .args(["daemon", "--owner", "desktop"])
                                .spawn()
                                .map_err(|error| error.to_string())
                        })
                        .map(|(mut events, child)| {
                            let event_log = sidecar_log.clone();
                            tauri::async_runtime::spawn(async move {
                                while let Some(event) = events.recv().await {
                                    match event {
                                        // Stdout can contain protocol/prompt content and is
                                        // intentionally drained without persistence.
                                        CommandEvent::Stdout(_) => {}
                                        CommandEvent::Stderr(bytes) => event_log.stderr(&bytes),
                                        CommandEvent::Error(error) => event_log.error(&error),
                                        CommandEvent::Terminated(payload) => {
                                            event_log.lifecycle(&format!(
                                                "daemon terminated (code={:?}, signal={:?})",
                                                payload.code, payload.signal
                                            ))
                                        }
                                        _ => event_log.error("received an unknown sidecar event"),
                                    }
                                }
                                event_log.lifecycle("sidecar event stream closed");
                            });
                            ManagedDaemon::Sidecar(child)
                        })
                        .map_err(|error| format!("could not spawn bundled daemon: {error}"))
                };

                match spawned {
                    Ok(child) => {
                        let daemon = DaemonProcess::new(Some(child));
                        if let Some(pid) = daemon.pid() {
                            eprintln!("warpforge: spawned daemon pid {pid}");
                            sidecar_log.lifecycle(&format!("spawned daemon pid {pid}"));
                        }
                        app.manage(daemon);
                    }
                    Err(error) => {
                        eprintln!("warning: {error}");
                        sidecar_log.error(&error);
                        app.manage(DaemonProcess::new(None));
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![daemon_endpoint])
        .plugin(tauri_plugin_dialog::init())
        .build(tauri::generate_context!())
        .expect("error building warpforge desktop")
        // Daemon remains a background service so ACP sessions can survive UI
        // restarts. The web UI asks before closing with running services and
        // sends `runtime.stopAll` when the user confirms.
        .run(|_app_handle, _event| {});
}
