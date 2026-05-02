// Module skeleton (T1.5). Each module is empty until its feature phase fills it in.
mod cli;
mod commands;
mod db;
mod ipc;
mod logging;
mod menu;
mod pty;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {name}! You've been greeted from Rust!")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    logging::init();
    tracing::info!(version = env!("CARGO_PKG_VERSION"), "work-station starting");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            commands::log::log_from_frontend
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
