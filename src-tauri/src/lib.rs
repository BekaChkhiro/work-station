// Module skeleton (T1.5). Each module is empty until its feature phase fills it in.
mod cli;
mod commands;
mod db;
mod ipc;
mod logging;
mod menu;
mod pty;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    logging::init();
    tracing::info!(version = env!("CARGO_PKG_VERSION"), "work-station starting");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // PTY registry (T2.3) — app-scoped so sessions survive webview reloads.
        .manage(pty::PtyManager::new())
        .invoke_handler(tauri::generate_handler![
            commands::log::log_from_frontend,
            commands::pty::pty_spawn,
            commands::pty::pty_write,
            commands::pty::pty_resize,
            commands::pty::pty_kill,
            commands::pty::pty_get_scrollback,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
