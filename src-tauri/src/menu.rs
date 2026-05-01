//! Native application menu (macOS).
//!
//! Sets up a standard macOS menu bar using Tauri's menu API.
//! Custom menu actions are forwarded to the frontend via `menu:event` events.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager, Runtime};

/// Payload sent to the frontend when a custom menu item is activated.
#[derive(Clone, serde::Serialize)]
struct MenuEventPayload {
    action: &'static str,
}

/// Build and install the native application menu.
///
/// Only has effect on macOS; on other platforms this is a no-op so the
/// WebView retains its default context-menu behaviour.
pub fn setup_menu<R: Runtime>(app: &tauri::App<R>) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        let menu = Menu::new(app)?;

        // ── App menu ──
        let app_submenu = Submenu::with_items(
            app,
            "Work Station",
            true,
            &[
                &PredefinedMenuItem::about(app, Some("About Work Station"), None)?,
                &PredefinedMenuItem::separator(app)?,
                &MenuItem::with_id(
                    app,
                    "check-updates",
                    "Check for Updates…",
                    true,
                    None::<&str>,
                )?,
                &PredefinedMenuItem::separator(app)?,
                &MenuItem::with_id(
                    app,
                    "preferences",
                    "Preferences…",
                    true,
                    Some("CmdOrCtrl+,"),
                )?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::hide(app, Some("Hide Work Station"))?,
                &PredefinedMenuItem::hide_others(app, None)?,
                &PredefinedMenuItem::show_all(app, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::quit(app, None)?,
            ],
        )?;
        menu.append(&app_submenu)?;

        // ── File ──
        let file_submenu = Submenu::with_items(
            app,
            "File",
            true,
            &[
                &MenuItem::with_id(
                    app,
                    "new-terminal",
                    "New Terminal",
                    true,
                    Some("CmdOrCtrl+T"),
                )?,
                &MenuItem::with_id(
                    app,
                    "new-terminal-tab",
                    "New Terminal Tab",
                    true,
                    None::<&str>,
                )?,
                &PredefinedMenuItem::separator(app)?,
                &MenuItem::with_id(app, "close-pane", "Close Pane", true, Some("CmdOrCtrl+W"))?,
                &PredefinedMenuItem::separator(app)?,
                &MenuItem::with_id(
                    app,
                    "new-project",
                    "New Project…",
                    true,
                    Some("CmdOrCtrl+Shift+N"),
                )?,
                &MenuItem::with_id(
                    app,
                    "open-project",
                    "Open Project Folder…",
                    true,
                    None::<&str>,
                )?,
            ],
        )?;
        menu.append(&file_submenu)?;

        // ── Edit ──
        let edit_submenu = Submenu::with_items(
            app,
            "Edit",
            true,
            &[
                &PredefinedMenuItem::undo(app, None)?,
                &PredefinedMenuItem::redo(app, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::cut(app, None)?,
                &PredefinedMenuItem::copy(app, None)?,
                &PredefinedMenuItem::paste(app, None)?,
                &PredefinedMenuItem::select_all(app, None)?,
                &PredefinedMenuItem::separator(app)?,
                &MenuItem::with_id(
                    app,
                    "clear-terminal",
                    "Clear Terminal",
                    true,
                    Some("CmdOrCtrl+K"),
                )?,
            ],
        )?;
        menu.append(&edit_submenu)?;

        // ── View ──
        let view_submenu = Submenu::with_items(
            app,
            "View",
            true,
            &[
                &MenuItem::with_id(app, "reload", "Reload", true, Some("CmdOrCtrl+R"))?,
                &PredefinedMenuItem::separator(app)?,
                &MenuItem::with_id(app, "toggle-theme", "Toggle Theme", true, None::<&str>)?,
                &PredefinedMenuItem::separator(app)?,
                &MenuItem::with_id(app, "zoom-in", "Zoom In", true, Some("CmdOrCtrl+Plus"))?,
                &MenuItem::with_id(app, "zoom-out", "Zoom Out", true, Some("CmdOrCtrl+Minus"))?,
                &MenuItem::with_id(app, "zoom-reset", "Reset Zoom", true, Some("CmdOrCtrl+0"))?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::fullscreen(app, None)?,
            ],
        )?;
        menu.append(&view_submenu)?;

        // ── Window ──
        let window_submenu = Submenu::with_items(
            app,
            "Window",
            true,
            &[
                &PredefinedMenuItem::minimize(app, None)?,
                &MenuItem::with_id(app, "zoom", "Zoom", true, None::<&str>)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::fullscreen(app, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::close_window(app, None)?,
                &PredefinedMenuItem::separator(app)?,
                &MenuItem::with_id(
                    app,
                    "bring-all-front",
                    "Bring All to Front",
                    true,
                    None::<&str>,
                )?,
            ],
        )?;
        menu.append(&window_submenu)?;

        // ── Help ──
        let help_submenu = Submenu::with_items(
            app,
            "Help",
            true,
            &[&MenuItem::with_id(
                app,
                "help",
                "Work Station Help",
                true,
                None::<&str>,
            )?],
        )?;
        menu.append(&help_submenu)?;

        app.set_menu(menu)?;

        app.on_menu_event(|app, event| {
            let action: Option<&'static str> = match event.id().0.as_str() {
                "new-terminal" => Some("new-terminal"),
                "new-terminal-tab" => Some("new-terminal-tab"),
                "close-pane" => Some("close-pane"),
                "new-project" => Some("new-project"),
                "open-project" => Some("open-project"),
                "clear-terminal" => Some("clear-terminal"),
                "reload" => Some("reload"),
                "toggle-theme" => Some("toggle-theme"),
                "zoom-in" => Some("zoom-in"),
                "zoom-out" => Some("zoom-out"),
                "zoom-reset" => Some("zoom-reset"),
                "bring-all-front" => Some("bring-all-front"),
                "help" => Some("help"),
                "check-updates" => Some("check-updates"),
                "preferences" => Some("preferences"),
                _ => None,
            };

            if let Some(action) = action {
                let payload = MenuEventPayload { action };
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.emit("menu:event", payload);
                }
            }
        });

        Ok(())
    }
}
