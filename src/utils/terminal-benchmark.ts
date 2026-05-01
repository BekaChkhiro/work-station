/**
 * Terminal rendering benchmark — measures xterm.js performance under load.
 *
 * Designed for the T10.4 output stress test.  Feeds data to an xterm.js
 * Terminal instance while sampling frame times via `requestAnimationFrame`,
 * then reports FPS statistics and main-thread freeze counts.
 *
 * Usage (manual QA or automated test):
 * ```ts
 * import { Terminal } from "@xterm/xterm";
 * import { benchmarkTerminal, generateStressData } from "~/utils/terminal-benchmark";
 *
 * const term = new Terminal({ rows: 24, cols: 80 });
 * term.open(document.getElementById("terminal")!);
 *
 * const data = generateStressData(1024 * 1024 * 1024); // 1 GiB
 * const result = await benchmarkTerminal(term, { data, chunkSize: 4096, durationMs: 30_000 });
 * console.log("Average FPS:", result.avgFps);
 * console.log("Freeze frames:", result.freezeFrameCount);
 * ```
 */

import type { Terminal as XTermTerminal } from "@xterm/xterm";

export interface BenchmarkOptions {
  /** Raw data or string to feed into the terminal. */
  data: Uint8Array | string;
  /** Size of each `term.write()` chunk in bytes (default 4096). */
  chunkSize?: number;
  /** How long to run the benchmark, in ms (default 10000). */
  durationMs?: number;
  /** Delay between chunks, in ms (default 16 ≈ 60 Hz). */
  chunkDelayMs?: number;
}

export interface BenchmarkResult {
  /** Arithmetic mean FPS over the whole run. */
  avgFps: number;
  /** Lowest instantaneous FPS recorded. */
  minFps: number;
  /** Longest single frame time in ms. */
  maxFrameTimeMs: number;
  /** Frames that took > 33 ms (dropped below 30 fps). */
  slowFrameCount: number;
  /** Frames that took > 50 ms (dropped below 20 fps, treated as a freeze). */
  freezeFrameCount: number;
  /** Total rAF callbacks observed. */
  totalFrames: number;
  /** Total bytes written to the terminal. */
  bytesWritten: number;
  /** Cumulative time spent inside `term.write()` calls. */
  totalWriteTimeMs: number;
}

/**
 * Generate a deterministic repeating byte pattern for stress testing.
 *
 * @param sizeBytes — total bytes to generate
 * @returns a `Uint8Array` filled with an ASCII pattern
 */
export function generateStressData(sizeBytes: number): Uint8Array {
  const pattern = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const buf = new Uint8Array(sizeBytes);
  for (let i = 0; i < sizeBytes; i++) {
    buf[i] = pattern.charCodeAt(i % pattern.length);
  }
  return buf;
}

/**
 * Run a rendering benchmark against an xterm.js Terminal.
 *
 * Spawns a `requestAnimationFrame` loop to sample frame timing while
 * writing chunks of `data` to the terminal on a fixed interval.
 *
 * @param term    — mounted xterm.js Terminal instance
 * @param options — benchmark configuration
 * @returns performance statistics
 */
export async function benchmarkTerminal(
  term: XTermTerminal,
  options: BenchmarkOptions
): Promise<BenchmarkResult> {
  const chunkSize = options.chunkSize ?? 4096;
  const durationMs = options.durationMs ?? 10_000;
  const chunkDelayMs = options.chunkDelayMs ?? 16;

  const data: Uint8Array =
    typeof options.data === "string"
      ? new TextEncoder().encode(options.data)
      : options.data;

  let offset = 0;
  let bytesWritten = 0;
  let totalWriteTimeMs = 0;
  let running = true;

  const frameTimes: number[] = [];
  let lastFrameTime = performance.now();

  function measureFrame() {
    const now = performance.now();
    const delta = now - lastFrameTime;
    lastFrameTime = now;
    frameTimes.push(delta);
    if (running) {
      requestAnimationFrame(measureFrame);
    }
  }

  requestAnimationFrame(measureFrame);

  const startTime = performance.now();
  while (offset < data.length && performance.now() - startTime < durationMs) {
    const end = Math.min(offset + chunkSize, data.length);
    const chunk = data.subarray(offset, end);

    const writeStart = performance.now();
    term.write(chunk);
    totalWriteTimeMs += performance.now() - writeStart;

    bytesWritten += chunk.length;
    offset = end;

    await new Promise<void>((resolve) => setTimeout(resolve, chunkDelayMs));
  }

  running = false;

  // Discard the first frame — it includes setup overhead.
  const validFrames = frameTimes.slice(1);
  const fpsValues = validFrames.map((t) => 1000 / t);
  const avgFps =
    fpsValues.length > 0
      ? fpsValues.reduce((a, b) => a + b, 0) / fpsValues.length
      : 0;
  const minFps =
    fpsValues.length > 0 ? Math.min(...fpsValues) : 0;
  const maxFrameTimeMs =
    validFrames.length > 0 ? Math.max(...validFrames) : 0;
  const slowFrameCount = validFrames.filter((t) => t > 33).length;
  const freezeFrameCount = validFrames.filter((t) => t > 50).length;

  return {
    avgFps,
    minFps,
    maxFrameTimeMs,
    slowFrameCount,
    freezeFrameCount,
    totalFrames: validFrames.length,
    bytesWritten,
    totalWriteTimeMs,
  };
}

/**
 * Assert that a benchmark result meets the T10.4 acceptance criteria.
 *
 * Throws an `Error` with a detailed message if any criterion fails.
 *
 * @param result    — output from {@link benchmarkTerminal}
 * @param criteria  — overrides for default thresholds
 */
export function assertBenchmarkPassed(
  result: BenchmarkResult,
  criteria?: {
    minAvgFps?: number;
    maxFreezeFrames?: number;
    maxSlowFrames?: number;
  }
): void {
  const minAvgFps = criteria?.minAvgFps ?? 55;
  const maxFreezeFrames = criteria?.maxFreezeFrames ?? 0;
  const maxSlowFrames = criteria?.maxSlowFrames ?? 5;

  const lines: string[] = [];

  if (result.avgFps < minAvgFps) {
    lines.push(
      `Average FPS too low: ${result.avgFps.toFixed(1)} (minimum ${minAvgFps})`
    );
  }
  if (result.freezeFrameCount > maxFreezeFrames) {
    lines.push(
      `Too many freeze frames: ${result.freezeFrameCount} (maximum ${maxFreezeFrames})`
    );
  }
  if (result.slowFrameCount > maxSlowFrames) {
    lines.push(
      `Too many slow frames: ${result.slowFrameCount} (maximum ${maxSlowFrames})`
    );
  }

  if (lines.length > 0) {
    throw new Error(
      `Benchmark failed (${lines.length} issue(s)):\n  - ${lines.join("\n  - ")}`
    );
  }
}
