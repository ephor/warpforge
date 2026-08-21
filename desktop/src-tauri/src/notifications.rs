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
        use mac_usernotifications::{Action, Notification};

        let mut notification = Notification::new()
            .title(&payload.title)
            .subtitle(&payload.subtitle)
            .message(&payload.body);
        if payload.kind == "permission" {
            notification = notification
                .action(Action::button("approve", "Approve"))
                .action(Action::button("reject", "Reject"));
        }
        notification = notification.action(Action::button("review", "Review"));

        let AttentionPayload {
            kind,
            task_id,
            request_id,
            ..
        } = payload;

        // macOS delivers the response on the main thread's run loop, so waiting for
        // it must not block: the crate's blocking wrappers only work off the main
        // thread while that run loop happens to be idle, which it is not right after
        // an IPC call. Awaiting the async API sidesteps the timing entirely.
        tauri::async_runtime::spawn(async move {
            let handle = match notification.send().await {
                Ok(handle) => handle,
                Err(error) => {
                    eprintln!("warpforge: notification send failed: {error:?}");
                    return;
                }
            };
            let response = match handle.response().await {
                Ok(response) => response,
                Err(error) => {
                    eprintln!("warpforge: notification response failed: {error:?}");
                    return;
                }
            };
            let action = if response.is_dismiss_action() {
                "__closed"
            } else if response.is_default_action() {
                "default"
            } else {
                &response.action_identifier
            };
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
