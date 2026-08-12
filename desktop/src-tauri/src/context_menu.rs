use serde::{Deserialize, Serialize};
use tauri::menu::{MenuBuilder, MenuItem, PredefinedMenuItem};
use tauri::Window;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextMenuItem {
    pub id: String,
    pub label: String,
    pub disabled: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ContextMenuItemOrSeparator {
    #[serde(rename = "item")]
    Item(ContextMenuItem),
    #[serde(rename = "separator")]
    Separator,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShowContextMenuRequest {
    pub request_id: String,
    pub items: Vec<ContextMenuItemOrSeparator>,
}

/// Show a native popup context menu at the OS cursor position.
///
/// Each menu item is given a compound id `ctx:{request_id}:{item_id}` so the
/// frontend can correlate clicks back to the component that opened the menu.
/// Selection events are surfaced by the `on_menu_event` handler registered in
/// `main.rs`, which emits them to the webview as `context-menu:clicked`.
///
/// Note: this intentionally does NOT use muda's event system directly — Tauri
/// intercepts muda menu events, so only the Tauri menu API works here.
#[tauri::command]
pub fn show_context_menu(window: Window, request: ShowContextMenuRequest) -> Result<(), String> {
    let mut builder = MenuBuilder::new(&window);

    for item in &request.items {
        match item {
            ContextMenuItemOrSeparator::Item(menu_item) => {
                let compound_id = format!("ctx:{}:{}", request.request_id, menu_item.id);
                let tauri_item = MenuItem::with_id(
                    &window,
                    &compound_id,
                    &menu_item.label,
                    !menu_item.disabled.unwrap_or(false),
                    None::<&str>,
                )
                .map_err(|e| e.to_string())?;
                builder = builder.item(&tauri_item);
            }
            ContextMenuItemOrSeparator::Separator => {
                let separator =
                    PredefinedMenuItem::separator(&window).map_err(|e| e.to_string())?;
                builder = builder.item(&separator);
            }
        }
    }

    let menu = builder.build().map_err(|e| e.to_string())?;
    window.popup_menu(&menu).map_err(|e| e.to_string())
}
