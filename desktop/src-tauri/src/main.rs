#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Warpforge desktop shell.
//!
//! Thin client by design: the webview talks to the daemon directly over its
//! WebSocket API. The only Rust-side capability is endpoint discovery —
//! reading `~/.warpforge/daemon.json`, which the browser sandbox can't do.

use warpforge_protocol::DaemonEndpoint;

#[tauri::command]
fn daemon_endpoint() -> Result<DaemonEndpoint, String> {
    let path = dirs::home_dir()
        .ok_or_else(|| "cannot determine home directory".to_string())?
        .join(".warpforge")
        .join("daemon.json");
    let text = std::fs::read_to_string(&path).map_err(|e| {
        format!(
            "cannot read {} — is the warpforge daemon running? ({e})",
            path.display()
        )
    })?;
    serde_json::from_str(&text).map_err(|e| format!("invalid daemon.json: {e}"))
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![daemon_endpoint])
        .run(tauri::generate_context!())
        .expect("error while running warpforge desktop");
}
