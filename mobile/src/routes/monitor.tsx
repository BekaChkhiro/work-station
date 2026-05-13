// T18.18 — System monitor view.
//
// The desktop's system_monitor (T18.5) broadcasts a `system_stats` frame
// to every authenticated socket every ~2 seconds. We just listen on the
// shared bridge — no subscribe handshake required — and re-render when a
// fresh snapshot arrives. A short ticker drives the staleness indicator
// without us having to re-render the whole route on every animation
// frame.

import { Match, Show, Switch, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { bridgeState, getBridge } from "../stores/wsBridge";
import type { ServerMessage } from "../lib/wsBridge";

interface Snapshot {
  cpuPercent: number;
  ramUsedBytes: number;
  ramTotalBytes: number;
  ptySessionCount: number;
}

// Stats arrive every 2 s; flag the readout as stale if we miss two ticks
// in a row. Anything shorter would flicker on a slightly delayed sample.
const STALE_AFTER_MS = 4_500;

export default function MonitorRoute() {
  const [snapshot, setSnapshot] = createSignal<Snapshot | null>(null);
  const [lastUpdate, setLastUpdate] = createSignal<number | null>(null);
  // `now` advances on a short timer so the stale flag can flip without
  // waiting for the next stats frame (which by definition won't arrive
  // when we are stale).
  const [now, setNow] = createSignal(Date.now());

  onMount(() => {
    const bridge = getBridge();
    let unsub: (() => void) | null = null;
    if (bridge) {
      unsub = bridge.onMessage((msg: ServerMessage) => {
        if (msg.type !== "system_stats") return;
        setSnapshot({
          cpuPercent: msg.cpu_percent,
          ramUsedBytes: msg.ram_used_bytes,
          ramTotalBytes: msg.ram_total_bytes,
          ptySessionCount: msg.pty_session_count,
        });
        setLastUpdate(Date.now());
      });
    }
    const tick = window.setInterval(() => setNow(Date.now()), 500);
    onCleanup(() => {
      unsub?.();
      window.clearInterval(tick);
    });
  });

  const isStale = createMemo(() => {
    const t = lastUpdate();
    if (t === null) return false;
    return now() - t > STALE_AFTER_MS;
  });

  const connState = () => bridgeState();
  const hasBridgeConfig = () => !!getBridge();

  return (
    <section class="flex min-h-[calc(100vh-128px)] flex-col gap-4 px-4 pt-4 pb-6">
      <header class="flex items-start justify-between gap-3">
        <div>
          <h1 class="text-fg text-xl font-semibold tracking-tight">Monitor</h1>
          <p class="text-fg-tertiary mt-0.5 text-xs">
            <Switch>
              <Match when={!hasBridgeConfig()}>
                Connect to Work Station to see live host stats.
              </Match>
              <Match when={connState() === "reconnecting"}>Reconnecting to desktop…</Match>
              <Match when={connState() !== "open"}>Waiting for the WebSocket bridge…</Match>
              <Match when={snapshot() === null}>Waiting for first sample…</Match>
              <Match when={isStale()}>
                Stalled — last sample {formatAge(now() - (lastUpdate() ?? now()))} ago.
              </Match>
              <Match when={true}>Live host stats — updates every 2 seconds.</Match>
            </Switch>
          </p>
        </div>
        <ConnectionBadge state={connState()} stale={isStale()} hasSnapshot={snapshot() !== null} />
      </header>

      <Show
        when={snapshot()}
        fallback={<EmptyState connected={connState() === "open"} configured={hasBridgeConfig()} />}
      >
        {(snap) => (
          <div class="flex flex-col gap-4">
            <CpuCard percent={snap().cpuPercent} stale={isStale()} />
            <RamCard used={snap().ramUsedBytes} total={snap().ramTotalBytes} stale={isStale()} />
            <SessionsCard count={snap().ptySessionCount} stale={isStale()} />
          </div>
        )}
      </Show>
    </section>
  );
}

// ---------- CPU ----------

function CpuCard(props: { percent: number; stale: boolean }) {
  const pct = () => clamp(props.percent, 0, 100);
  const color = () => severityColor(pct());

  // Circular gauge: 80% of a full circle so the bottom gap reads as a
  // dial rather than a complete ring. radius 64, stroke 12 → 76×76 box
  // plus padding so the stroke isn't clipped.
  const RADIUS = 64;
  const STROKE = 12;
  const SIZE = 160;
  const CENTER = SIZE / 2;
  const CIRC = 2 * Math.PI * RADIUS;
  // Sweep covers 270° — leaves a 90° gap centred at the bottom.
  const SWEEP_FRACTION = 0.75;
  const trackLength = CIRC * SWEEP_FRACTION;
  // SVG arcs start at 3 o'clock by default; rotate -135° so the gap
  // sits symmetrically at the bottom of the dial.
  const ROTATION = -135;
  const fillLength = () => trackLength * (pct() / 100);

  return (
    <div
      class={`bg-surface border-border-default flex items-center gap-4 rounded-lg border p-4 transition-opacity ${
        props.stale ? "opacity-60" : "opacity-100"
      }`}
    >
      <div
        class="relative flex shrink-0 items-center justify-center"
        style={{ width: `${SIZE}px`, height: `${SIZE}px` }}
      >
        <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true">
          <g transform={`rotate(${ROTATION} ${CENTER} ${CENTER})`}>
            <circle
              cx={CENTER}
              cy={CENTER}
              r={RADIUS}
              fill="none"
              stroke="color-mix(in oklch, var(--text-tertiary) 30%, transparent)"
              stroke-width={STROKE}
              stroke-linecap="round"
              stroke-dasharray={`${trackLength} ${CIRC}`}
            />
            <circle
              cx={CENTER}
              cy={CENTER}
              r={RADIUS}
              fill="none"
              stroke={color()}
              stroke-width={STROKE}
              stroke-linecap="round"
              stroke-dasharray={`${fillLength()} ${CIRC}`}
              style={{ transition: "stroke-dasharray var(--dur-base) var(--ease)" }}
            />
          </g>
        </svg>
        <div class="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span
            class="text-fg text-3xl font-semibold tabular tracking-tight"
            style={{ color: color() }}
          >
            {pct().toFixed(0)}
            <span class="text-fg-tertiary text-base font-normal">%</span>
          </span>
          <span class="text-fg-tertiary mt-0.5 text-[10px] uppercase tracking-wider">CPU</span>
        </div>
      </div>
      <div class="flex min-w-0 flex-col gap-1">
        <h2 class="text-fg text-sm font-semibold">CPU usage</h2>
        <p class="text-fg-tertiary text-xs">
          Average across all logical cores. Reported by the desktop's sysinfo sampler.
        </p>
        <p class="text-fg-secondary tabular text-xs">
          <span class="text-fg-tertiary">Status:</span> {severityLabel(pct())}
        </p>
      </div>
    </div>
  );
}

// ---------- RAM ----------

function RamCard(props: { used: number; total: number; stale: boolean }) {
  const ratio = () => (props.total > 0 ? clamp(props.used / props.total, 0, 1) : 0);
  const pct = () => ratio() * 100;
  const color = () => severityColor(pct());

  return (
    <div
      class={`bg-surface border-border-default flex flex-col gap-3 rounded-lg border p-4 transition-opacity ${
        props.stale ? "opacity-60" : "opacity-100"
      }`}
    >
      <div class="flex items-baseline justify-between gap-3">
        <h2 class="text-fg text-sm font-semibold">RAM</h2>
        <span class="text-fg tabular text-sm font-medium">
          {formatBytes(props.used)}
          <span class="text-fg-tertiary"> / {formatBytes(props.total)}</span>
        </span>
      </div>
      <div
        class="bg-elevated relative h-3 w-full overflow-hidden rounded-full"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct())}
        aria-label="RAM usage"
      >
        <div
          class="h-full rounded-full"
          style={{
            width: `${pct()}%`,
            "background-color": color(),
            transition: "width var(--dur-base) var(--ease)",
          }}
        />
      </div>
      <div class="flex items-center justify-between gap-2 text-xs">
        <span class="text-fg-tertiary">Used {pct().toFixed(1)}%</span>
        <span class="text-fg-tertiary">
          Free {formatBytes(Math.max(0, props.total - props.used))}
        </span>
      </div>
    </div>
  );
}

// ---------- Sessions ----------

function SessionsCard(props: { count: number; stale: boolean }) {
  return (
    <div
      class={`bg-surface border-border-default flex items-center justify-between gap-3 rounded-lg border p-4 transition-opacity ${
        props.stale ? "opacity-60" : "opacity-100"
      }`}
    >
      <div class="flex min-w-0 flex-col">
        <h2 class="text-fg text-sm font-semibold">Active sessions</h2>
        <p class="text-fg-tertiary text-xs">
          PTYs tracked by the desktop — includes both GUI and PWA terminals.
        </p>
      </div>
      <span
        class="bg-elevated text-fg tabular inline-flex h-12 min-w-[3rem] items-center justify-center rounded-md px-3 text-2xl font-semibold"
        aria-label={`${props.count} active sessions`}
      >
        {props.count}
      </span>
    </div>
  );
}

// ---------- Status helpers ----------

function ConnectionBadge(props: { state: string; stale: boolean; hasSnapshot: boolean }) {
  const tone = () => {
    if (props.state !== "open") return "warning";
    if (props.stale) return "warning";
    if (!props.hasSnapshot) return "neutral";
    return "ok";
  };
  const dot = () => {
    switch (tone()) {
      case "ok":
        return "var(--success)";
      case "warning":
        return "var(--warning)";
      default:
        return "color-mix(in oklch, var(--text-tertiary) 70%, transparent)";
    }
  };
  const label = () => {
    if (props.state === "open") {
      if (props.stale) return "Stalled";
      if (!props.hasSnapshot) return "Waiting";
      return "Live";
    }
    if (props.state === "reconnecting") return "Reconnecting";
    if (props.state === "connecting") return "Connecting";
    if (props.state === "closing" || props.state === "closed") return "Offline";
    return "Idle";
  };
  return (
    <span class="bg-elevated border-border-default text-fg-secondary inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-medium">
      <span class="h-2 w-2 rounded-full" style={{ "background-color": dot() }} aria-hidden="true" />
      {label()}
    </span>
  );
}

function EmptyState(props: { connected: boolean; configured: boolean }) {
  return (
    <div class="bg-surface border-border-default flex flex-col items-center gap-2 rounded-lg border p-6 text-center">
      <p class="text-fg text-sm font-medium">
        <Show
          when={!props.configured}
          fallback={props.connected ? "Waiting for first sample…" : "Bridge is offline"}
        >
          Not connected
        </Show>
      </p>
      <p class="text-fg-tertiary text-xs">
        <Show
          when={props.configured}
          fallback={
            <>Open the Auth tab and pair this PWA with the desktop Work Station instance.</>
          }
        >
          <Show
            when={props.connected}
            fallback={
              <>The desktop will push CPU, RAM, and session stats once the WebSocket reconnects.</>
            }
          >
            Stats arrive every 2 seconds.
          </Show>
        </Show>
      </p>
    </div>
  );
}

// ---------- pure helpers ----------

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function severityColor(pct: number): string {
  if (pct >= 85) return "var(--error)";
  if (pct >= 60) return "var(--warning)";
  return "var(--accent)";
}

function severityLabel(pct: number): string {
  if (pct >= 85) return "Saturated";
  if (pct >= 60) return "Busy";
  if (pct >= 25) return "Active";
  return "Idle";
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const precision = value >= 100 || unit === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[unit]}`;
}

function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "moments";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}
