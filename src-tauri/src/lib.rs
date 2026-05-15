// Module skeleton (T1.5). Each module is empty until its feature phase fills it in.
use tauri::webview::PageLoadEvent;
use tauri::Manager;

// T19.1 — Tauri-free runtime modules now live in `workstation-core`.
// Re-export them under their old paths so command handlers and other
// modules keep using `crate::cli::…`, `crate::shell_path::…`, etc.
// without churning call sites. `credentials`, `pty`, and `push` are
// included here because `commands/*` and `ws/*` reference them via
// `crate::…`; the underlying logic has no Tauri coupling.
pub use workstation_core::{cli, credentials, logging, pairing, pty, push, shell_path};

mod commands;
mod db;
// T11.4: HTTP client + cache. The downstream consumers (T11.6 connection
// test, T11.8 token refresh, T11.9 offline queue, T12+ integrations) land
// in later tasks; until then the public surface is unused on the live
// boot path and `dead_code` would noise up every build.
#[allow(dead_code)]
mod http;
mod ipc;
mod menu;
// Cloudflare quick-tunnel manager. Spawned after the WS bridge binds so
// the mobile PWA (HTTPS origin) can reach the loopback-only listener
// without LAN reachability / mixed-content headaches.
mod tunnel;
// T18.1 / T18.2 / T18.3 — embedded HTTP + WebSocket server that bridges
// the mobile PWA to the existing PtyManager. Started in `setup` below
// once the SQLite migrations have run (auth token lives in
// `app_settings`).
mod ws;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
// Bootstrap wiring is inherently long — module setup, async migration
// tasks, command-handler registration — and lives in one function so
// the boot order is auditable in a single read. Refactoring purely to
// satisfy the line count would scatter that order across helpers.
#[allow(clippy::too_many_lines)]
pub fn run() {
    logging::init();
    tracing::info!(version = env!("CARGO_PKG_VERSION"), "work-station starting");

    // macOS GUI launches inherit launchd's minimal PATH (~ `/usr/bin:/bin`),
    // so user-installed CLIs like claude/kimi/codex (npm, brew, nvm) are
    // invisible to the registry below and to PTY spawns. Hydrate from the
    // user's interactive login shell before any thread that reads PATH —
    // CLI detection (this `setup`) and pty::manager (later, on demand) —
    // gets a chance to start. No-op on Windows.
    shell_path::hydrate_from_login_shell();

    // T10.2: cold-start bench exit. When WS_BENCH_EXIT=1, the app tears
    // down on the main webview's `load` event so `hyperfine` can measure
    // spawn → first-paint → exit as a single wall-clock interval. The
    // env flag is the only switch; in production launches the callback
    // checks it once per page-load and falls through, so the cost is a
    // single env::var read at startup.
    let bench_exit = std::env::var("WS_BENCH_EXIT").as_deref() == Ok("1");

    tauri::Builder::default()
        .on_page_load(move |window, payload| {
            if bench_exit && payload.event() == PageLoadEvent::Finished {
                tracing::info!(target: "bench", "WS_BENCH_EXIT: page load finished, exiting");
                window.app_handle().exit(0);
            }
        })
        .plugin(tauri_plugin_opener::init())
        // T3.1: SQLite (preloaded via tauri.conf.json plugins.sql.preload) + key-value store.
        // T3.5: migrations are applied by our own runner (db::run_migrations) so we
        // can wrap each one in a transaction and, in T3.10, restore from backup on
        // failure. The plugin's built-in migration step is intentionally not used.
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        // T3.7: native folder picker for project paths.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // T-fix: HTTP requests to third-party integrations (PlanFlow, GitHub,
        // Vercel, Neon, Railway). Webview `fetch` is blocked by CORS for
        // services that don't echo `Access-Control-Allow-Origin`; routing
        // through Rust avoids that entirely.
        .plugin(tauri_plugin_http::init())
        // PTY registry (T2.3) — app-scoped so sessions survive webview reloads.
        .manage(pty::PtyManager::new())
        // T7.1: detected-CLI registry, populated once at boot below. App-scoped
        // so the frontend (T7.2) sees the same cached list across windows.
        .manage(cli::CliRegistry::new())
        // T13.5: editor file-watch state. Holds the notify watcher plus per-
        // open-file hash bookkeeping so we can spot external writes without
        // chasing spurious mtime events. Created eagerly, watcher lazily.
        .manage(commands::watch::FileWatchManager::new())
        // Mobile-pairing state — populated once the WS bridge binds; read
        // by `get_pairing_info` to render the Settings QR.
        .manage(pairing::PairingState::default())
        .setup(|app| {
            if let Err(error) = menu::install(app) {
                tracing::error!(target: "menu", %error, "native menu install failed");
            }
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

                // T18.1 + T18.2 + T18.3: stand up the WebSocket bridge
                // *after* migrations so the auth-token row can land in
                // `app_settings`. Failure here only takes down the
                // mobile bridge — the desktop GUI keeps working.
                let manager = handle.state::<pty::PtyManager>().inner().clone();
                let pool = match db::pool(&handle).await {
                    Ok(pool) => pool,
                    Err(error) => {
                        tracing::error!(target: "ws", %error, "ws bridge: could not resolve sqlite pool");
                        return;
                    }
                };

                // T18.19: boot the Web Push subsystem. Failure here is
                // not fatal — the WS bridge still serves /ws + /healthz
                // without the /push/* surface. The desktop GUI continues
                // working either way.
                let push_service = match push::init(pool.clone()).await {
                    Ok(service) => {
                        tracing::info!(
                            target: "push",
                            "web push subsystem booted",
                        );
                        Some(service)
                    }
                    Err(error) => {
                        tracing::error!(target: "push", %error, "web push init failed");
                        None
                    }
                };

                // T18.6: PlanFlow Tasks bridge. The bridge reuses the
                // generic http::Client (retries, cache, rate-limit
                // handling) and pulls the user's PlanFlow API token
                // from the OS keychain on each call. A boot failure
                // only disables the PlanFlow surface — the rest of
                // the WS bridge (PTY, push, projects, system stats)
                // still serves traffic, and /ws clients see a typed
                // `planflow_error{unavailable}` when they hit a
                // PlanFlow message variant.
                let planflow_state = match crate::http::Client::new(
                    pool.clone(),
                    crate::http::ClientConfig::default(),
                ) {
                    Ok(client) => {
                        tracing::info!(target: "ws", "planflow bridge ready");
                        Some(ws::PlanflowState::new(client))
                    }
                    Err(error) => {
                        tracing::error!(target: "ws", %error, "planflow bridge init failed");
                        None
                    }
                };

                match ws::init(&pool, manager, push_service, handle.clone(), planflow_state).await {
                    Ok(info) => {
                        tracing::info!(
                            target: "ws",
                            addr = %info.addr,
                            "ws bridge listening",
                        );
                        let port = info.addr.port();
                        let state = handle.state::<pairing::PairingState>();
                        state.set_bridge(info.addr, info.token);
                        // Open a Cloudflare quick tunnel so the mobile
                        // PWA can reach the loopback-bound bridge via
                        // HTTPS. Failure is non-fatal — the Settings UI
                        // surfaces the reason and falls back to LAN.
                        tunnel::spawn(handle.clone(), port);
                    }
                    Err(error) => {
                        tracing::error!(target: "ws", %error, "ws bridge: init failed");
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
            commands::projects::project_update_workspace_tabs,
            commands::integration_queue::integration_queue_enqueue,
            commands::integration_queue::integration_queue_list,
            commands::integration_queue::integration_queue_dequeue,
            commands::integration_queue::integration_queue_mark_failed,
            commands::integration_queue::integration_queue_clear_service,
            commands::project_links::project_link_list,
            commands::project_links::project_link_set,
            commands::project_links::project_link_delete,
            commands::picker::pick_project_folder,
            commands::fs::fs_list_dir,
            commands::files::read_text_file,
            commands::files::write_text_file,
            commands::watch::start_file_watch,
            commands::watch::stop_file_watch,
            commands::cli::cli_list_available,
            commands::clipboard::save_clipboard_image,
            commands::credentials::credentials_set,
            commands::credentials::credentials_get,
            commands::credentials::credentials_delete,
            commands::credentials::credentials_has,
            commands::push::push_notify,
            commands::push::push_notify_task_done,
            commands::push::push_notify_task_error,
            commands::push::push_status,
            commands::pairing::get_pairing_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
