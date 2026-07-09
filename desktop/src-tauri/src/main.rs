#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::Manager;
use warpforge_protocol::DaemonEndpoint;

struct DaemonProcess(Mutex<Option<Child>>);

/// Find the warpforge daemon binary.
///
/// Priority:
///   1. WARPFORGE_DAEMON_BIN env var (explicit override)
///   2. Sibling to current exe (prod app bundle)
///   3. workspace/target/debug/warpforge (Tauri dev layout)
///   4. "warpforge" on PATH
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
            return serde_json::from_str(&text).map_err(|e| format!("invalid daemon.json: {e}"));
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
        .setup(|app| {
            if is_daemon_running() {
                eprintln!("warpforge: daemon already running — reusing");
                app.manage(DaemonProcess(Mutex::new(None)));
            } else {
                let bin = find_daemon_bin();
                match Command::new(&bin).arg("daemon").spawn() {
                    Ok(c) => {
                        app.manage(DaemonProcess(Mutex::new(Some(c))));
                    }
                    Err(e) => {
                        eprintln!("warning: could not spawn daemon ({bin:?}): {e}");
                        app.manage(DaemonProcess(Mutex::new(None)));
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![daemon_endpoint])
        .build(tauri::generate_context!())
        .expect("error building warpforge desktop")
        // Daemon remains a background service so ACP sessions can survive UI
        // restarts. The web UI asks before closing with running services and
        // sends `runtime.stopAll` when the user confirms.
        .run(|_app_handle, _event| {});
}
