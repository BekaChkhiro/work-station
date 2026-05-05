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
        // T3.1: SQLite (preloaded via tauri.conf.json plugins.sql.preload) + key-value store.
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        // PTY registry (T2.3) — app-scoped so sessions survive webview reloads.
        .manage(pty::PtyManager::new())
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match db::hello(&handle).await {
                    Ok(value) => {
                        tracing::info!(target: "db", select_one = value, "sqlite preloaded");
                    }
                    Err(error) => {
                        tracing::error!(target: "db", %error, "sqlite preload failed");
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::log::log_from_frontend,
            commands::pty::pty_spawn,
            commands::pty::pty_write,
            commands::pty::pty_resize,
            commands::pty::pty_kill,
            commands::pty::pty_get_scrollback,
            commands::pty::pty_subscribe,
            commands::pty::pty_get_backpressure_stats,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
