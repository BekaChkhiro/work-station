// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

pub mod cli;
pub mod commands;
pub mod db;
pub mod ipc;
pub mod pty;

use cli::CliRegistry;
use commands::{
    cli_list_available, pty_get_scrollback, pty_kill, pty_resize, pty_spawn, pty_subscribe, pty_write,
    pick_folder,
};
use commands::project::{project_create, project_delete, project_list, project_update};
use pty::PtyManager;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_sql::Builder::new()
                .add_migrations("sqlite:workstation.db", db::migrations::up_migrations())
                .build(),
        )
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(PtyManager::new())
        .manage(CliRegistry::new())
        .invoke_handler(tauri::generate_handler![
            greet,
            cli_list_available,
            pty_spawn,
            pty_subscribe,
            pty_resize,
            pty_kill,
            pty_write,
            pty_get_scrollback,
            project_list,
            project_create,
            project_update,
            project_delete,
            pick_folder,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
