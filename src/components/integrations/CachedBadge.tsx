// T11.9 — Badge that shows how stale cached data is.
//
// Updates every 30 s via a Solid interval-based signal so the displayed age
// stays accurate without a full component remount. The 30 s resolution is
// intentional: sub-minute freshness is communicated as "just now", and
// polling more frequently would thrash the layout for no user benefit.
//
// Usage:
//   <CachedBadge cachedAt={entry.cachedAt} />

import { createSignal, onCleanup, type JSX } from "solid-js";

export interface CachedBadgeProps {
  /** Unix timestamp in milliseconds of when the data was last fetched. */
  cachedAt: number;
  class?: string;
}

const REFRESH_INTERVAL_MS = 30_000;

function formatAge(cachedAt: number, now: number): string {
  const elapsedMs = now - cachedAt;
  if (elapsedMs <= 60_000) return "just now";
  const minutes = Math.round(elapsedMs / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export function CachedBadge(props: CachedBadgeProps): JSX.Element {
  const [now, setNow] = createSignal(Date.now());

  const interval = setInterval(() => {
    setNow(Date.now());
  }, REFRESH_INTERVAL_MS);

  onCleanup(() => clearInterval(interval));

  const label = (): string => `(cached, ${formatAge(props.cachedAt, now())})`;

  return (
    <span
      class={props.class}
      aria-label={label()}
      title={new Date(props.cachedAt).toLocaleString()}
      style={{
        "font-size": "var(--fs-11)",
        "font-style": "italic",
        color: "var(--text-tertiary)",
        "white-space": "nowrap",
      }}
    >
      {label()}
    </span>
  );
}

export default CachedBadge;
