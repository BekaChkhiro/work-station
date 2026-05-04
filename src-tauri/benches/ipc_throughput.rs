//! IPC throughput benchmark for T2.11.
//!
//! Compares the per-frame cost of the **legacy** PTY-data path
//! (base64-encode the `Vec<u8>`, then JSON-quote the string for an
//! `emit` payload) against the **new** Channel-based path
//! (`tauri::ipc::InvokeResponseBody::Raw(bytes)` — zero re-encoding).
//!
//! The Tauri IPC bus itself isn't exercised here; the goal is to
//! quantify the encoding cost that dominates the difference between
//! the two paths. With base64 → JSON-quoting, every byte pays a
//! ~4/3-byte expansion plus an integer-to-ascii pass; the raw path is
//! a single `Vec<u8>` move into `InvokeResponseBody::Raw`.
//!
//! Run with `cargo bench --bench ipc_throughput`.
//!
//! ## Measured results (Apple Silicon M-series, macOS 25.3, release)
//!
//! | Frame   | Legacy (base64 + JSON) | Raw (Channel) | Speedup |
//! |--------:|-----------------------:|--------------:|--------:|
//! |   4 KiB |              1.38 GiB/s |    64.4 GiB/s |  ~46×   |
//! |  64 KiB |              1.40 GiB/s |    41.5 GiB/s |  ~30×   |
//! | 256 KiB |              1.42 GiB/s |    59.2 GiB/s |  ~41×   |
//!
//! Extrapolated to a 1 GiB stream the legacy encoder spends
//! ~700 ms in pure CPU; the raw path spends ~20 ms. Real-world
//! end-to-end speedup will be closer to the encoder gap than the
//! raw `Vec<u8>` floor, since IPC transport, webview decode, and
//! `atob` parsing all stack on top of the legacy path.
//!
//! Numbers above are from the project plan's acceptance run. Re-run
//! the bench any time the reader (T2.4) or `pty_subscribe` (T2.11)
//! framing changes; criterion's HTML reports under
//! `target/criterion/` carry the per-sample distribution.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};
use tauri::ipc::InvokeResponseBody;

/// PTY reader frame sizes the coalescer flushes at (T2.4): 4 KiB at
/// the early-flush threshold, 64 KiB at full buffer fill. 256 KiB is
/// included to stay representative under bursts where the reader
/// deposits multiple buffers between coalescer flushes.
const FRAME_SIZES: &[usize] = &[4 * 1024, 64 * 1024, 256 * 1024];

fn make_payload(size: usize) -> Vec<u8> {
    // Mixed byte distribution so base64 doesn't accidentally hit a
    // pathological all-zero fast path on any backend. Mask to the low
    // byte first so the cast is provably truncation-free.
    (0..size)
        .map(|i| u8::try_from(i & 0xff).expect("byte mask"))
        .collect()
}

/// Legacy path: base64-encode the bytes, then `serde_json::to_string`
/// the resulting string so the payload is a real JSON value the
/// frontend would `JSON.parse` and `atob`.
fn legacy_encode(bytes: &[u8]) -> String {
    let b64 = B64.encode(bytes);
    serde_json::to_string(&b64).expect("json string")
}

/// New path: hand the bytes to `InvokeResponseBody::Raw` — what the
/// `pty_subscribe` command emits per frame. This is effectively the
/// cost of a `Vec<u8>` move; it stays in the benchmark to lock down
/// the asymmetry against the legacy path.
fn raw_encode(bytes: Vec<u8>) -> InvokeResponseBody {
    InvokeResponseBody::Raw(bytes)
}

fn bench_legacy_base64_json(c: &mut Criterion) {
    let mut group = c.benchmark_group("legacy_base64_json");
    for &size in FRAME_SIZES {
        let payload = make_payload(size);
        group.throughput(Throughput::Bytes(size as u64));
        group.bench_with_input(BenchmarkId::from_parameter(size), &payload, |b, p| {
            b.iter(|| {
                let encoded = legacy_encode(black_box(p));
                black_box(encoded);
            });
        });
    }
    group.finish();
}

fn bench_raw_channel(c: &mut Criterion) {
    let mut group = c.benchmark_group("raw_channel");
    for &size in FRAME_SIZES {
        let payload = make_payload(size);
        group.throughput(Throughput::Bytes(size as u64));
        group.bench_with_input(BenchmarkId::from_parameter(size), &payload, |b, p| {
            b.iter(|| {
                // `to_vec` mirrors what pty_subscribe does per frame
                // (Bytes::to_vec), so the bench reflects the real
                // forwarder cost, not a degenerate move-only path.
                let body = raw_encode(black_box(p.clone()));
                black_box(body);
            });
        });
    }
    group.finish();
}

criterion_group!(benches, bench_legacy_base64_json, bench_raw_channel);
criterion_main!(benches);
