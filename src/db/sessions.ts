// Sessions DB helpers — re-exports the layout schema for the
// `sessions.layout_json` column.
//
// T3.3: layout_json is a TEXT column in SQLite (see migrations/0002_sessions.sql)
// holding a JSON-encoded layout tree. T5.1 promoted the schema to its own
// module (`src/types/layout.ts`) so the renderer (T5.4) and persistence
// helpers can share one source of truth. This module remains the
// persistence-side entry point and keeps `parseLayout` for back-compat.

export {
  EMPTY_LAYOUT,
  EmptyLayoutSchema,
  LayoutSchema,
  PaneNodeSchema,
  parseLayoutJson as parseLayout,
} from "../types/layout";
export type { EmptyLayout, Layout, PaneNode } from "../types/layout";
