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
            let bin = find_daemon_bin();
            let child = Command::new(&bin).arg("daemon").spawn();
            match child {
                Ok(c) => {
                    app.manage(DaemonProcess(Mutex::new(Some(c))));
                }
                Err(e) => {
                    eprintln!("warning: could not spawn daemon ({bin:?}): {e}");
                    app.manage(DaemonProcess(Mutex::new(None)));
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![daemon_endpoint])
        .build(tauri::generate_context!())
        .expect("error building warpforge desktop")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                if let Ok(mut guard) = app_handle.state::<DaemonProcess>().0.lock() {
                    if let Some(mut child) = guard.take() {
                        // SIGTERM → daemon stops services gracefully, then SIGKILL.
                        #[cfg(unix)]
                        {
                            let pid = child.id();
                            let _ = std::process::Command::new("kill")
                                .args(["-TERM", &pid.to_string()])
                                .status();
                            std::thread::sleep(std::time::Duration::from_millis(800));
                        }
                        let _ = child.kill();
                    }
                }
            }
        });
}
