// T5.3: Tab metadata used by TabStrip and downstream wiring (T5.4 LayoutTree,
// T7.7 CLI badge). The TabStrip is purely presentational — it does not load
// or persist tabs; it renders whatever the parent passes and emits intent
// events. The DB shape (sessions table, T3.3) and the layout tree (T5.1) are
// separate concerns; this is the minimum the strip needs to draw a row.

export interface Tab {
  /** Stable identifier, also used as the React/Solid key. */
  id: string;
  /** Visible tab label — typically the project + cwd or session title. */
  label: string;
  /** CLI key looked up in `cliMap` for the badge cell. Undefined → fallback. */
  cli?: string;
  /** True when a process is running in the tab; renders the dirty dot. */
  dirty?: boolean;
}

export interface CliMeta {
  /** Two-character monogram drawn in the badge cell, e.g. "cc", "km", "zs". */
  badge: string;
  /** Optional accent color for the badge in the inactive state. */
  color?: string;
}
