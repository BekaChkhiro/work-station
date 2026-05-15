//! Tracing setup for the cloud-agent daemon.
//!
//! Stdout/stderr only — systemd captures both streams into the
//! journal (`journalctl -u cloud-agent`) so we don't need the daily
//! file rotation that the desktop binary's `workstation-core::logging`
//! does. A panic hook routes panics through `tracing::error!` so the
//! crash payload lands in the journal in the same shape as ordinary
//! error events.

use tracing_subscriber::fmt;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::EnvFilter;

/// Initialise the global tracing subscriber.
///
/// `filter` follows the standard `EnvFilter` syntax (e.g. `info` or
/// `cloud_agent=debug,workstation_core=info`). On parse failure we
/// fall back to `info` and emit a single stderr line — the daemon
/// must not refuse to boot just because a filter string is malformed.
pub fn init(filter: &str) {
    let env_filter = EnvFilter::try_new(filter).unwrap_or_else(|e| {
        eprintln!("[cloud-agent] invalid log_filter {filter:?} ({e}); falling back to `info`");
        EnvFilter::new("info")
    });

    let stderr_layer = fmt::layer()
        .with_ansi(false) // journald renders ANSI as escape sequences
        .with_target(true)
        .with_thread_ids(false)
        .with_writer(std::io::stderr);

    let init_result = tracing_subscriber::registry()
        .with(env_filter)
        .with(stderr_layer)
        .try_init();

    if let Err(e) = init_result {
        eprintln!("[cloud-agent] tracing subscriber already set: {e}");
        return;
    }

    install_panic_hook();
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
