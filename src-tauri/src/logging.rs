//! Logging infrastructure (T1.9).
//!
//! Initializes a `tracing` subscriber that writes to a platform-standard
//! log directory with daily rotation, and installs a panic hook so crashes
//! land in the same file (the last few lines of the log are the crash trail).
//!
//! Layout:
//!   macOS:   ~/Library/Logs/work-station/
//!   Windows: %LOCALAPPDATA%\work-station\logs\
//!   Linux:   $XDG_DATA_HOME/work-station/logs/  (fallback ~/.local/share/...)
//!
//! Log filter is taken from `WORK_STATION_LOG` (e.g. `info,work_station_lib=debug`)
//! with `info` as the default.

use std::path::PathBuf;
use std::sync::OnceLock;

use tracing::Level;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_appender::rolling;
use tracing_subscriber::fmt;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::EnvFilter;

const LOG_FILE_PREFIX: &str = "work-station";
const LOG_FILE_SUFFIX: &str = "log";
const KEEP_LAST_N_LOGS: usize = 7;
const ENV_FILTER_VAR: &str = "WORK_STATION_LOG";
const DEFAULT_FILTER: &str = "info";

// Hold the non-blocking writer's guard for the process lifetime so buffered
// log lines flush on shutdown — including panics, where the panic hook fires
// before unwinding tears down statics.
static GUARD: OnceLock<WorkerGuard> = OnceLock::new();

/// Resolve the platform log directory.
#[must_use]
pub fn log_dir() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        dirs::home_dir().map(|p| p.join("Library").join("Logs").join("work-station"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        dirs::data_local_dir().map(|p| p.join("work-station").join("logs"))
    }
}

/// Initialize the global tracing subscriber. Safe to call once at app start.
pub fn init() {
    let Some(dir) = log_dir() else {
        eprintln!("[work-station] could not determine log dir; logging to stderr only");
        init_console_only();
        return;
    };

    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!(
            "[work-station] failed to create log dir {}: {e}; logging to stderr only",
            dir.display()
        );
        init_console_only();
        return;
    }

    let appender_result = rolling::Builder::new()
        .rotation(rolling::Rotation::DAILY)
        .max_log_files(KEEP_LAST_N_LOGS)
        .filename_prefix(LOG_FILE_PREFIX)
        .filename_suffix(LOG_FILE_SUFFIX)
        .build(&dir);

    let file_appender = match appender_result {
        Ok(a) => a,
        Err(e) => {
            eprintln!(
                "[work-station] failed to build rolling log appender at {}: {e}; logging to stderr only",
                dir.display()
            );
            init_console_only();
            return;
        }
    };

    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);

    let file_layer = fmt::layer()
        .with_ansi(false)
        .with_target(true)
        .with_thread_ids(false)
        .with_writer(non_blocking);

    let stderr_layer = fmt::layer()
        .with_ansi(true)
        .with_target(true)
        .with_writer(std::io::stderr);

    let init_result = tracing_subscriber::registry()
        .with(default_filter())
        .with(file_layer)
        .with(stderr_layer)
        .try_init();

    if let Err(e) = init_result {
        eprintln!("[work-station] tracing subscriber already set: {e}");
        return;
    }

    // Drop on shutdown flushes the appender. set() is no-op on second call.
    let _ = GUARD.set(guard);

    install_panic_hook();

    tracing::info!(dir = %dir.display(), "logging initialized");
}

fn init_console_only() {
    let _ = fmt::Subscriber::builder()
        .with_env_filter(default_filter())
        .with_writer(std::io::stderr)
        .try_init();
    install_panic_hook();
}

fn default_filter() -> EnvFilter {
    EnvFilter::try_from_env(ENV_FILTER_VAR).unwrap_or_else(|_| EnvFilter::new(DEFAULT_FILTER))
}

fn install_panic_hook() {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info.location().map_or_else(
            || "<unknown>".to_string(),
            |l| format!("{}:{}", l.file(), l.line()),
        );
        let payload = info
            .payload()
            .downcast_ref::<&'static str>()
            .copied()
            .map(ToOwned::to_owned)
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "<non-string panic payload>".to_string());
        tracing::error!(
            target: "panic",
            location = %location,
            payload = %payload,
            "panic"
        );
        prev(info);
    }));
}

/// Map a frontend log level string to a tracing `Level`. Unknown → `INFO`.
#[must_use]
pub fn level_from_str(level: &str) -> Level {
    match level {
        "error" => Level::ERROR,
        "warn" => Level::WARN,
        "debug" => Level::DEBUG,
        "trace" => Level::TRACE,
        _ => Level::INFO,
    }
}

#[cfg(test)]
mod tests {
    use super::{install_panic_hook, level_from_str, log_dir};
    use std::io::{self, Write};
    use std::sync::{Arc, Mutex};
    use tracing::Level;
    use tracing_subscriber::fmt::MakeWriter;

    #[test]
    fn level_from_str_maps_known_levels() {
        assert_eq!(level_from_str("error"), Level::ERROR);
        assert_eq!(level_from_str("warn"), Level::WARN);
        assert_eq!(level_from_str("info"), Level::INFO);
        assert_eq!(level_from_str("debug"), Level::DEBUG);
        assert_eq!(level_from_str("trace"), Level::TRACE);
        assert_eq!(level_from_str("nonsense"), Level::INFO);
    }

    #[test]
    fn log_dir_resolves_to_platform_path() {
        let dir = log_dir().expect("log_dir should resolve on supported platforms");
        let s = dir.to_string_lossy();

        #[cfg(target_os = "macos")]
        assert!(s.ends_with("Library/Logs/work-station"), "got {s}");
        #[cfg(target_os = "windows")]
        assert!(s.ends_with("work-station\\logs"), "got {s}");
        #[cfg(target_os = "linux")]
        assert!(s.ends_with("work-station/logs"), "got {s}");
    }

    #[derive(Clone)]
    struct BufWriter(Arc<Mutex<Vec<u8>>>);

    impl Write for BufWriter {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl<'a> MakeWriter<'a> for BufWriter {
        type Writer = BufWriter;
        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }

    #[test]
    fn panic_hook_emits_panic_event_through_tracing() {
        let buffer = Arc::new(Mutex::new(Vec::<u8>::new()));
        let writer = BufWriter(buffer.clone());

        let subscriber = tracing_subscriber::fmt()
            .with_writer(writer)
            .with_max_level(Level::ERROR)
            .with_ansi(false)
            .with_target(true)
            .finish();

        tracing::subscriber::with_default(subscriber, || {
            install_panic_hook();
            let _ = std::panic::catch_unwind(|| {
                panic!("hook test panic message");
            });
        });

        let captured = String::from_utf8(buffer.lock().unwrap().clone()).unwrap();
        assert!(
            captured.contains("panic"),
            "expected target/event 'panic' in captured output, got: {captured}"
        );
        assert!(
            captured.contains("hook test panic message"),
            "expected panic payload in captured output, got: {captured}"
        );
    }
}
