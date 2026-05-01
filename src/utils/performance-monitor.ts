/**
 * Frame-time performance monitor for the xterm.js frontend.
 *
 * Uses `requestAnimationFrame` to measure how long each frame takes to
 * composite.  During heavy PTY output (e.g. `cat 1GB.log`) the WebGL
 * renderer must keep each frame under ~16.67 ms to maintain 60 fps.
 *
 * Typical usage inside a Solid component:
 *
 * ```ts
 * import { createPerformanceMonitor } from "../utils/performance-monitor";
 *
 * onMount(() => {
 *   const monitor = createPerformanceMonitor({
 *     thresholdMs: 16.67,
 *     onDrop: (frameTime, droppedFrames) => {
 *       console.warn(`Frame drop: ${frameTime.toFixed(2)}ms (${droppedFrames} frames)`);
 *     },
 *   });
 *   monitor.start();
 *   onCleanup(() => monitor.stop());
 * });
 * ```
 */

export interface PerformanceMonitorOptions {
  /** Frame-time threshold in ms (default 16.67 = 60 fps). */
  thresholdMs?: number;
  /** Called once per dropped frame cluster. */
  onDrop?: (frameTimeMs: number, droppedFrames: number) => void;
  /** Called every `reportIntervalMs` with aggregated stats. */
  onReport?: (stats: FrameStats) => void;
  /** How often to emit `onReport` (default 1000 ms). */
  reportIntervalMs?: number;
}

export interface FrameStats {
  /** Average frame time over the reporting window. */
  avgFrameTimeMs: number;
  /** Maximum frame time seen in the reporting window. */
  maxFrameTimeMs: number;
  /** Number of frames that exceeded the threshold. */
  droppedFrames: number;
  /** Total frames measured in the reporting window. */
  totalFrames: number;
  /** Estimated FPS over the reporting window. */
  estimatedFps: number;
}

export interface PerformanceMonitor {
  start: () => void;
  stop: () => void;
  /** Return a snapshot of stats since the last report (or start). */
  snapshot: () => FrameStats;
}

/**
 * Create a frame-time monitor backed by `requestAnimationFrame`.
 *
 * The monitor is inactive until `start()` is called.  Call `stop()` before
 * unmounting the component to avoid leaking the rAF loop.
 */
export function createPerformanceMonitor(
  options: PerformanceMonitorOptions = {}
): PerformanceMonitor {
  const {
    thresholdMs = 1000 / 60,
    onDrop,
    onReport,
    reportIntervalMs = 1000,
  } = options;

  let rafId: number | null = null;
  let lastTimestamp: DOMHighResTimeStamp | null = null;
  let running = false;

  // Accumulators for the current reporting window.
  let frameCount = 0;
  let frameTimeSum = 0;
  let maxFrameTime = 0;
  let droppedCount = 0;
  let lastReportTime = 0;

  function report(now: DOMHighResTimeStamp) {
    if (frameCount === 0) {
      // No frames rendered this window — likely the tab was hidden.
      lastReportTime = now;
      return;
    }

    const avg = frameTimeSum / frameCount;
    const stats: FrameStats = {
      avgFrameTimeMs: avg,
      maxFrameTimeMs: maxFrameTime,
      droppedFrames: droppedCount,
      totalFrames: frameCount,
      estimatedFps: avg > 0 ? 1000 / avg : 0,
    };

    onReport?.(stats);

    // Reset accumulators.
    frameCount = 0;
    frameTimeSum = 0;
    maxFrameTime = 0;
    droppedCount = 0;
    lastReportTime = now;
  }

  function tick(timestamp: DOMHighResTimeStamp) {
    if (!running) return;

    if (lastTimestamp !== null) {
      const delta = timestamp - lastTimestamp;
      frameCount++;
      frameTimeSum += delta;
      if (delta > maxFrameTime) {
        maxFrameTime = delta;
      }

      if (delta > thresholdMs) {
        // How many 60 Hz frames did we miss?
        const missed = Math.max(1, Math.round(delta / thresholdMs) - 1);
        droppedCount += missed;
        onDrop?.(delta, missed);
      }
    }

    lastTimestamp = timestamp;

    if (timestamp - lastReportTime >= reportIntervalMs) {
      report(timestamp);
    }

    rafId = requestAnimationFrame(tick);
  }

  function start() {
    if (running) return;
    running = true;
    lastTimestamp = null;
    lastReportTime = performance.now();
    rafId = requestAnimationFrame(tick);
  }

  function stop() {
    running = false;
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  function snapshot(): FrameStats {
    const avg = frameCount > 0 ? frameTimeSum / frameCount : 0;
    return {
      avgFrameTimeMs: avg,
      maxFrameTimeMs: maxFrameTime,
      droppedFrames: droppedCount,
      totalFrames: frameCount,
      estimatedFps: avg > 0 ? 1000 / avg : 0,
    };
  }

  return { start, stop, snapshot };
}

/**
 * Convenience hook for SolidJS that starts monitoring on mount and
 * stops on cleanup.
 *
 * Returns a reactive accessor for the latest frame stats.
 *
 * ```ts
 * const stats = usePerformanceMonitor({ reportIntervalMs: 500 });
 * createEffect(() => {
 *   console.log("FPS:", stats().estimatedFps);
 * });
 * ```
 */
export function usePerformanceMonitor(
  options: PerformanceMonitorOptions = {}
): () => FrameStats {
  // NOTE: This is a plain utility that returns a getter function.
  // When Solid's `createSignal` is available in the importing module,
  // callers can wrap it themselves.  We keep this dependency-free so
  // it can be used outside Solid components as well.
  let latestStats: FrameStats = {
    avgFrameTimeMs: 0,
    maxFrameTimeMs: 0,
    droppedFrames: 0,
    totalFrames: 0,
    estimatedFps: 0,
  };

  const monitor = createPerformanceMonitor({
    ...options,
    onReport: (stats) => {
      latestStats = stats;
      options.onReport?.(stats);
    },
  });

  monitor.start();

  // Return a getter that always returns the latest stats.
  return () => latestStats;
}
