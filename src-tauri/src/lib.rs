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
        .invoke_handler(tauri::generate_handler![commands::log::log_from_frontend])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
