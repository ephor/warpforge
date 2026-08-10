use serde::Deserialize;
// `Emitter` is only used inside the macOS body below; importing it
// unconditionally warns on every other platform.
#[cfg(target_os = "macos")]
use tauri::Emitter;
use tauri::AppHandle;

/// Payload for a native macOS attention notification raised from the web UI
/// when the app is backgrounded. `kind` selects which action buttons to offer.
#[derive(Deserialize)]
pub struct AttentionPayload {
    /// `"permission"` offers Approve/Reject/Review; anything else offers Review only.
    pub kind: String,
    pub task_id: String,
    pub request_id: Option<String>,
    pub title: String,
    pub subtitle: String,
    pub body: String,
}

/// Raise a native macOS notification with action buttons. On non-macOS this is a
/// no-op; the in-house web toasts cover those platforms.
#[tauri::command]
pub fn notify_attention(
    #[allow(unused_variables)] app: AppHandle,
    #[allow(unused_variables)] payload: AttentionPayload,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use notify_rust::Notification;

        let mut builder = Notification::new();
        builder.summary(&payload.title);
        builder.subtitle(&payload.subtitle);
        builder.body(&payload.body);
        if payload.kind == "permission" {
            builder.action("approve", "Approve");
            builder.action("reject", "Reject");
        }
        builder.action("review", "Review");

        let handle = builder.show().map_err(|e| e.to_string())?;

        // wait_for_action blocks the calling thread until the user responds, so it
        // runs on a background thread. Tauri is a GUI app: the main thread already
        // spins the run loop that macOS delivers the response to, so the callback
        // fires here and we relay it to the web UI, which owns the daemon client.
        let app = app.clone();
        let kind = payload.kind.clone();
        let task_id = payload.task_id.clone();
        let request_id = payload.request_id.clone();
        std::thread::spawn(move || {
            handle.wait_for_action(move |action| {
                let _ = app.emit(
                    "notification-action",
                    serde_json::json!({
                        "kind": kind,
                        "task_id": task_id,
                        "request_id": request_id,
                        "action": action,
                    }),
                );
            });
        });
    }
    Ok(())
}

/// Best-effort notification setup for macOS: verify the binary is bundled (the
/// UserNotifications backend requires it) and request user permission. Never
/// fails the app; on failure we silently fall back to in-house toasts.
pub fn init() {
    #[cfg(target_os = "macos")]
    {
        use mac_usernotifications::{blocking, check_bundle};
        match check_bundle() {
            Ok(()) => {
                if let Err(e) = blocking::request_auth() {
                    eprintln!("warpforge: notification permission request failed: {e}");
                }
            }
            Err(e) => eprintln!(
                "warpforge: native notifications unavailable (unbundled binary): {e}"
            ),
        }
    }
}
