//! Native menu wiring: macOS app menu.
//!
//! Windows mirrors this command set in the webview hamburger menu because
//! the app uses hidden chrome there.

#[cfg(target_os = "macos")]
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    App, Emitter, Manager, Runtime,
};

#[cfg(target_os = "macos")]
const MENU_EVENT: &str = "ws://menu-action";

#[cfg(target_os = "macos")]
const APP_MENU_IDS: &[&str] = &[
    "new-project",
    "new-terminal",
    "close-pane",
    "save-file",
    "open-settings",
    "find-in-pane",
    "toggle-sidebar",
    "quick-switcher",
    "switch-project-1",
    "switch-project-2",
    "switch-project-3",
    "switch-project-4",
    "switch-project-5",
    "switch-project-6",
    "switch-project-7",
    "switch-project-8",
    "switch-project-9",
    "documentation",
    "report-issue",
];

#[cfg(target_os = "macos")]
pub fn install<R: Runtime>(app: &App<R>) -> tauri::Result<()> {
    let handle = app.handle();
    let app_menu = app_menu(handle)?;
    let file = file_menu(handle)?;
    let edit = edit_menu(handle)?;
    let view = view_menu(handle)?;
    let help = help_menu(handle)?;
    let menu = Menu::with_items(handle, &[&app_menu, &file, &edit, &view, &help])?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        let id = event.id().0.as_str();
        if APP_MENU_IDS.contains(&id) {
            if let Err(error) = app.emit(MENU_EVENT, id) {
                tracing::warn!(target: "menu", %id, %error, "failed to emit menu action");
            }
        }
    });
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn install<R: tauri::Runtime>(_app: &tauri::App<R>) -> tauri::Result<()> {
    Ok(())
}

#[cfg(target_os = "macos")]
fn app_menu<R: Runtime>(handle: &tauri::AppHandle<R>) -> tauri::Result<Submenu<R>> {
    Submenu::with_items(
        handle,
        handle.package_info().name.clone(),
        true,
        &[
            &PredefinedMenuItem::about(handle, None, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::hide(handle, None)?,
            &PredefinedMenuItem::hide_others(handle, None)?,
            &PredefinedMenuItem::show_all(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::quit(handle, None)?,
        ],
    )
}

#[cfg(target_os = "macos")]
fn file_menu<R: Runtime>(handle: &tauri::AppHandle<R>) -> tauri::Result<Submenu<R>> {
    Submenu::with_items(
        handle,
        "File",
        true,
        &[
            &item(handle, "new-project", "New Project", "CmdOrCtrl+N")?,
            &item(handle, "new-terminal", "New Terminal", "CmdOrCtrl+T")?,
            &item(handle, "close-pane", "Close Pane", "CmdOrCtrl+W")?,
            &PredefinedMenuItem::separator(handle)?,
            &item(handle, "save-file", "Save File", "CmdOrCtrl+S")?,
            &PredefinedMenuItem::separator(handle)?,
            &item(handle, "open-settings", "Settings", "CmdOrCtrl+,")?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::quit(handle, None)?,
        ],
    )
}

#[cfg(target_os = "macos")]
fn edit_menu<R: Runtime>(handle: &tauri::AppHandle<R>) -> tauri::Result<Submenu<R>> {
    Submenu::with_items(
        handle,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::copy(handle, Some("Copy"))?,
            &PredefinedMenuItem::paste(handle, Some("Paste"))?,
            &item(handle, "find-in-pane", "Find in Pane", "CmdOrCtrl+F")?,
        ],
    )
}

#[cfg(target_os = "macos")]
fn view_menu<R: Runtime>(handle: &tauri::AppHandle<R>) -> tauri::Result<Submenu<R>> {
    Submenu::with_items(
        handle,
        "View",
        true,
        &[
            &item(handle, "toggle-sidebar", "Toggle Sidebar", "CmdOrCtrl+B")?,
            &item(handle, "quick-switcher", "Quick Switcher", "CmdOrCtrl+K")?,
            &PredefinedMenuItem::separator(handle)?,
            &item(
                handle,
                "switch-project-1",
                "Switch to Project 1",
                "CmdOrCtrl+1",
            )?,
            &item(
                handle,
                "switch-project-2",
                "Switch to Project 2",
                "CmdOrCtrl+2",
            )?,
            &item(
                handle,
                "switch-project-3",
                "Switch to Project 3",
                "CmdOrCtrl+3",
            )?,
            &item(
                handle,
                "switch-project-4",
                "Switch to Project 4",
                "CmdOrCtrl+4",
            )?,
            &item(
                handle,
                "switch-project-5",
                "Switch to Project 5",
                "CmdOrCtrl+5",
            )?,
            &item(
                handle,
                "switch-project-6",
                "Switch to Project 6",
                "CmdOrCtrl+6",
            )?,
            &item(
                handle,
                "switch-project-7",
                "Switch to Project 7",
                "CmdOrCtrl+7",
            )?,
            &item(
                handle,
                "switch-project-8",
                "Switch to Project 8",
                "CmdOrCtrl+8",
            )?,
            &item(
                handle,
                "switch-project-9",
                "Switch to Project 9",
                "CmdOrCtrl+9",
            )?,
        ],
    )
}

#[cfg(target_os = "macos")]
fn help_menu<R: Runtime>(handle: &tauri::AppHandle<R>) -> tauri::Result<Submenu<R>> {
    Submenu::with_items(
        handle,
        "Help",
        true,
        &[
            &item(handle, "documentation", "Documentation", "")?,
            &item(handle, "report-issue", "Report Issue", "")?,
        ],
    )
}

#[cfg(target_os = "macos")]
fn item<R: Runtime>(
    manager: &impl Manager<R>,
    id: &'static str,
    label: &'static str,
    accelerator: &'static str,
) -> tauri::Result<MenuItem<R>> {
    let accelerator = if accelerator.is_empty() {
        None
    } else {
        Some(accelerator)
    };
    MenuItem::with_id(manager, id, label, true, accelerator)
}
