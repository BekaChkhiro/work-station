//! Benchmark: JSON-encoded Vec<u8> vs InvokeResponseBody::Raw
//!
//! Run with: cargo bench --bench ipc_throughput
//!
//! This demonstrates why T2.11 switched from `Channel<Vec<u8>>` to
//! `Channel<InvokeResponseBody>`:
//! - Vec<u8> serialises to a JSON array: every byte → 1–4 chars + commas.
//! - InvokeResponseBody::Raw bypasses JSON and uses the fetch API for
//!   payloads > 1 KiB, cutting both serialisation time and wire size.

use std::time::Instant;

fn bench_json_encode(data: &[u8], iterations: usize) -> (std::time::Duration, usize) {
    let start = Instant::now();
    let mut total_size = 0;
    for _ in 0..iterations {
        let json = serde_json::to_string(&data).unwrap();
        total_size += json.len();
    }
    (start.elapsed(), total_size / iterations)
}

fn bench_raw_body(data: &[u8], iterations: usize) -> (std::time::Duration, usize) {
    let start = Instant::now();
    let mut total_size = 0;
    for _ in 0..iterations {
        let body = tauri::ipc::InvokeResponseBody::Raw(data.to_vec());
        // IpcResponse::body for InvokeResponseBody is a no-op clone
        let size = match &body {
            tauri::ipc::InvokeResponseBody::Raw(v) => v.len(),
            tauri::ipc::InvokeResponseBody::Json(s) => s.len(),
        };
        total_size += size;
    }
    (start.elapsed(), total_size / iterations)
}

fn main() {
    let sizes = [64, 1024, 16_384, 65_536, 1_048_576];
    let iterations = 100;

    println!("╔════════════════╦═══════════════╦═══════════════╦═══════════════╦═══════════════╗");
    println!("║ Payload size   ║ JSON time     ║ Raw time      ║ JSON wire     ║ Raw wire      ║");
    println!("╠════════════════╬═══════════════╬═══════════════╬═══════════════╬═══════════════╣");

    for &size in &sizes {
        let data: Vec<u8> = (0..size).map(|i| (i % 256) as u8).collect();

        let (json_t, json_size) = bench_json_encode(&data, iterations);
        let (raw_t, raw_size) = bench_raw_body(&data, iterations);

        let json_us = json_t.as_micros() as f64 / iterations as f64;
        let raw_us = raw_t.as_micros() as f64 / iterations as f64;
        let speedup = if raw_us < 0.01 { json_us / 0.01 } else { json_us / raw_us };
        let overhead = json_size as f64 / raw_size as f64;

        println!(
            "║ {:>14} ║ {:>10.2} µs ║ {:>10.2} µs ║ {:>13} ║ {:>13} ║",
            format!("{} B", size),
            json_us,
            raw_us,
            format!("{} B ({:.1}x)", json_size, overhead),
            format!("{} B (1.0x)", raw_size),
        );
        println!(
            "║                ║ {:>13} ║ {:>13} ║               ║               ║",
            format!("({:.1}x slower)", speedup),
            "(baseline)"
        );
        if size != sizes.last().copied().unwrap() {
            println!("╠════════════════╬═══════════════╬═══════════════╬═══════════════╬═══════════════╣");
        }
    }

    println!("╚════════════════╩═══════════════╩═══════════════╩═══════════════╩═══════════════╝");
    println!();
    println!("Notes:");
    println!("  • JSON time = serde_json::to_string(&Vec<u8>) overhead");
    println!("  • Raw time  = wrapping bytes in InvokeResponseBody::Raw (no copy in steady state)");
    println!("  • For payloads > 1 KiB Tauri uses the fetch API, avoiding eval() entirely.");
}
