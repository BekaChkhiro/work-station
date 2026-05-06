// Module skeleton (T1.5). Each module is empty until its feature phase fills it in.
use tauri::Manager;

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
        // T3.5: migrations are applied by our own runner (db::run_migrations) so we
        // can wrap each one in a transaction and, in T3.10, restore from backup on
        // failure. The plugin's built-in migration step is intentionally not used.
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        // T3.7: native folder picker for project paths.
        .plugin(tauri_plugin_dialog::init())
        // PTY registry (T2.3) — app-scoped so sessions survive webview reloads.
        .manage(pty::PtyManager::new())
        // T7.1: detected-CLI registry, populated once at boot below. App-scoped
        // so the frontend (T7.2) sees the same cached list across windows.
        .manage(cli::CliRegistry::new())
        .setup(|app| {
            let handle = app.handle().clone();
            // T7.1: kick off the PATH scan on a blocking pool — `metadata`
            // calls hit the disk and we don't want to share Tokio worker
            // threads with the migration task above. Detection is bounded
            // by candidate count × PATH length so it finishes well inside
            // the 200ms boot budget on every platform we ship to.
            let cli_handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                // Time only the actual scan — capturing `start` outside
                // `spawn_blocking` would also count scheduler latency
                // when the blocking pool is saturated by the migration
                // task below, which would inflate the metric and trip
                // any future "boot scan exceeded budget" alarm falsely.
                let result = tokio::task::spawn_blocking(move || {
                    let start = std::time::Instant::now();
                    let registry = cli_handle.state::<cli::CliRegistry>();
                    let detected = registry.populate_default().to_vec();
                    (detected, start.elapsed())
                })
                .await;
                match result {
                    Ok((detected, elapsed)) => {
                        tracing::info!(
                            target: "cli",
                            count = detected.len(),
                            elapsed_ms = u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX),
                            ids = ?detected.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
                            "cli registry populated"
                        );
                    }
                    Err(error) => {
                        tracing::error!(target: "cli", %error, "cli registry scan panicked");
                    }
                }
            });
            tauri::async_runtime::spawn(async move {
                // T3.9: WAL + foreign_keys + busy_timeout before any schema
                // work so the very first migration writes land in WAL mode
                // and can survive a crash with the FK invariants intact.
                if let Err(error) = db::apply_pragmas_app(&handle).await {
                    tracing::error!(target: "db", %error, "sqlite pragma setup failed");
                    return;
                }
                match db::run_migrations(&handle).await {
                    Ok(report) => {
                        tracing::info!(
                            target: "db",
                            applied = ?report.applied,
                            skipped = ?report.skipped,
                            "schema migrations complete"
                        );
                    }
                    Err(error) => {
                        tracing::error!(target: "db", %error, "schema migrations failed");
                        return;
                    }
                }
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
            commands::projects::project_list,
            commands::projects::project_create,
            commands::projects::project_update,
            commands::projects::project_delete,
            commands::projects::project_reorder,
            commands::picker::pick_project_folder,
            commands::cli::cli_list_available,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
