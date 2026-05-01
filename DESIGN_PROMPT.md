# Claude Design Prompt — Work Station

> Paste this prompt into Claude (or any UI design tool) to generate the visual design for Work Station. Self-contained — no other context needed.

---

You are a **senior product designer** specializing in dense, professional desktop applications for developers. Your job is to design the UI for **Work Station** — a cross-platform desktop hub (macOS + Windows) that manages multiple AI-CLI terminal sessions across projects.

Work the design as if you were responsible for shipping it: opinionated, specific, internally consistent. Make decisions; do not present options unless I ask.

---

## 1. Product in one paragraph

Work Station is for developers who currently juggle 5–20 terminal tabs across many repositories — running Claude Code, Kimi, Codex, build commands, and shells. The app collapses that into a single window where each **project** is a workspace with its own tab + split layout, default CLI, env vars, and persistent state. Switching projects is instant; PTYs of all projects stay alive in the background.

This is a **professional power-user tool**. Not a consumer app. Optimize for: information density without clutter, calm undistracting chrome, fast visual recognition, native feel on each OS.

---

## 2. Target user

- 25–45-year-old senior developer.
- Daily-driver tool for 6–10 hours/day.
- Comfortable with terminals, hotkeys, IDE-class density.
- Runs AI CLIs in many parallel projects.
- Value: speed and reliability over delight.

---

## 3. Design language

### Reference apps (feel LIKE these)

- **Linear** — subtle chrome, restrained color, professional polish.
- **Warp** — terminal-first, modern, dark-native.
- **Cursor / VSCode** — comfortable density, panel hierarchy.
- **Raycast** — quick-switcher modal pattern.
- **Arc browser** — sidebar treatment, color-coded workspace identity.

### Anti-references (do NOT feel like these)

- Notion — too rounded, too consumer-friendly.
- Slack / Discord — too playful, too saturated.
- Default macOS Finder — too sparse.
- Tmux / raw terminals — too utilitarian, no UI grammar.
- Material Design — too elevated, too animated.

### Tone

Quiet, confident, fast. The chrome disappears when you're typing. Color is used sparingly and means something specific (project identity, status). No decorative gradients. No glassmorphism in primary surfaces.

---

## 4. Visual tokens

### Themes

- **Dark** — primary, default. Design here first.
- **Light** — derived. Must be readable in bright office light.
- **System** — follow OS preference.

### Color palette (dark theme — propose specific hex values)

- `bg.canvas` — deepest neutral, almost black. Suggest `#0b0c0e` or similar.
- `bg.surface` — main panel surface. Slightly lighter, ~+4% L*.
- `bg.elevated` — modals, dropdowns. ~+8% L*.
- `bg.terminal` — terminal background. May match `bg.canvas` or be slightly tinted.
- `border.subtle` — hairline dividers, near-invisible.
- `border.default` — visible separators between regions.
- `border.focus` — focused pane ring. Tinted with brand accent.
- `text.primary` — UI labels.
- `text.secondary` — meta info, timestamps.
- `text.tertiary` — placeholder, muted hints.
- `text.terminal` — terminal default foreground (warm off-white).
- `accent.brand` — single brand color, used sparingly. Propose: a desaturated electric tone (lime/teal/violet — pick one and commit).
- `accent.brand.muted` — same hue at lower saturation for subtle highlights.
- Project swatches — 8 distinct hues for user-assigned project colors. Propose them.
- Semantic: `success`, `warning`, `error`, `info` — muted enough to coexist with terminal output (no neon).

### Light theme

Mirror tokens. Background near-white but warm (avoid pure `#FFFFFF` glare). Borders slightly stronger than dark theme to compensate.

### Typography

- **UI**: Inter (variable), system-ui fallback. Sizes: 11/12/13/14/16/20/24px. Default body: 13px.
- **Mono (terminal + code)**: JetBrains Mono, Geist Mono, or Berkeley Mono — pick one, justify in 1 line. Default size: 13px, line-height 1.4.
- **Tabular numerals** for any number column.
- Letter-spacing: -0.01em on UI text, none on mono.

### Spacing

- 4px base grid. Increments used: 4, 8, 12, 16, 20, 24, 32, 48.
- Panel padding: 12–16px.
- Component vertical rhythm: 8px between related, 16px between groups.

### Radius

- 4px small (buttons, inputs).
- 6px medium (cards, modal sections).
- 8px large (modals, popovers).
- 0px terminal pane (no rounded corner inside layout grid).

### Motion

- Default: 150–200ms ease-out.
- Tab switch, sidebar collapse, modal in/out: 200ms.
- Pane focus ring: 100ms (instant feel).
- `prefers-reduced-motion`: durations → 0, transitions still apply.
- No bouncing, no overshoots. Calm, confident.

### Elevation

- Single shadow layer. Modal/popover only.
- `shadow.popover`: subtle, dark-friendly. e.g. `0 8px 24px rgba(0,0,0,0.32)`.
- No elevation on inline panels (use borders).

---

## 5. Layout — main window

Sidebar is on the **RIGHT** (per product decision — do not move).

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  [traffic lights]                  Project Title              [─][▢][✕]     │  ← Title bar (mac: inset; win: in-window)
├──────────────────────────────────────────────────────────────┬──────────────┤
│  ┌──Tab1──┐ ┌──Tab2──┐ ┌──Tab3──┐ ┌──Tab4──┐  [+]            │ ▣ Project A  │  ← Tab strip (per project)
│                                                                │ ▣ Project B  │
├──────────────────────────────────────────────────────────────┤ ▣ Project C  │  ← Sidebar (right, ~220px)
│                                                                │   ↑ active   │
│  ┌─────────────────────────────┐ ┌──────────────────────────┐ │ ▣ Project D  │
│  │                             │ │                          │ │ ▣ Project E  │
│  │   Terminal pane (focused)   │ │   Terminal pane          │ │              │
│  │   ▶ claude code             │ │   ▶ pnpm dev             │ │              │
│  │                             │ │                          │ │  ──────────  │
│  │                             │ │                          │ │  + New Proj  │
│  └─────────────────────────────┘ └──────────────────────────┘ │              │
│  ┌────────────────────────────────────────────────────────┐  │              │
│  │   Terminal pane                                        │  │              │
│  │   ▶ zsh                                                │  │              │
│  └────────────────────────────────────────────────────────┘  │              │
│                                                                │              │
└──────────────────────────────────────────────────────────────┴──────────────┘
```

### Regions

1. **Title bar** — minimal. Project title centered (or left). Traffic lights / window controls platform-specific. Drag region.
2. **Tab strip** — horizontal, scrollable when overflows, per-project. Active tab has subtle bottom-border accent.
3. **Layout area** — recursive splits + panes. Pane = one xterm.js terminal.
4. **Sidebar** — project list. Always visible by default; collapsible.

### Sizing

- Window minimum: 1024 × 640.
- Window default: 1440 × 900.
- Sidebar: 220px default, 60px collapsed (icons only), drag-to-resize 180–320px.
- Tab strip height: 36px.
- Title bar height: 28px (mac), 32px (win).

---

## 6. Components to design (in priority order)

For each, design dark theme first, then light. Show all states.

### P0 — Must design

1. **Main window — empty state** (no projects yet)
   - Centered onboarding card: "Add your first project". CTA button. Optional secondary: "Import from `.workstation` file" (greyed for v0.1).
2. **Main window — populated**
   - 3+ projects in sidebar, one active.
   - Active project shows 3 tabs, current tab has 2-pane vertical split.
3. **Tab strip**
   - Tab states: default, hover, active, dragging, dirty (process running), close-button-hover.
   - "+" new tab button at end.
   - Overflow: horizontal scroll with subtle gradient mask.
4. **Terminal pane**
   - States: default, focused (border accent ring), hidden (paused).
   - In-pane title bar (very thin) with: CLI badge icon, cwd label (truncated path with tooltip), pane menu (⋯).
   - Empty pane state ("Pick a CLI to start" with CLI list).
5. **Split resize handle**
   - States: idle (1px line), hover (2px tinted), dragging (full-width tinted bar).
   - Cursor: ew-resize / ns-resize.
6. **Sidebar — project list**
   - Project row: color swatch, icon, name, running session count badge.
   - States: default, hover, active, drag-handle-hover, dragging.
   - Collapsed state: icon-only, 60px wide.
   - Section header: "PROJECTS" subtle uppercase label.
   - Footer: "+ New project" button, settings icon.
7. **Add Project modal**
   - Fields: Name, Folder (with native picker button), Color (swatches), Icon (8-12 icon options), Default CLI (dropdown of detected CLIs).
   - Validation: inline errors.
   - Footer: Cancel, Create.
8. **Quick switcher modal (Cmd/Ctrl+K)**
   - Centered overlay, ~480px wide.
   - Search input on top.
   - Result list: project rows (color, name, last-active timestamp).
   - Keyboard hint: ↑↓ navigate, ↵ select, Esc close.
9. **CLI launch dropdown** (per pane)
   - Submenu of detected CLIs: claude, kimi, codex, zsh, bash, pwsh.
   - Each row: icon, name, version, path (muted).
   - Footer: "+ Add custom CLI" (defer to v0.2 — show greyed).

### P1 — Important

10. **Settings page**
    - Left rail with sections: General, Appearance, Keybindings, CLIs, Privacy.
    - Right content: form rows.
    - Hotkey rebinder: row with label + current binding chip + edit button.
11. **Edit/Delete project modal**
    - Mirrors Add Project. Footer adds destructive Delete button (text button, red).
    - Confirm deletion modal: shows running session count.
12. **In-terminal search overlay** (Cmd/Ctrl+F)
    - Top-right of pane, ~320px wide.
    - Input + match count + ↑↓ + close.
13. **Loading / skeleton states**
    - Sidebar shimmer, terminal mounting placeholder.
14. **Error states**
    - Pane error (PTY failed to spawn) — inline card with retry CTA.
    - Modal error toast (top-right).
    - Crash recovery banner.

### P2 — Polish

15. **Window chrome variants**
    - macOS: traffic-light inset, no visible title bar.
    - Windows: custom title bar with min/max/close icons (right-aligned, 16×16).
16. **Onboarding flow** (first-launch)
    - 3 steps max: welcome, telemetry consent toggle, first project.
17. **Update prompt** — non-blocking banner: "Update available. Restart to apply."
18. **About dialog** — version, license, links.

---

## 7. Interaction details to capture in design

- **Active pane focus ring**: 1px inset, accent color at 60% opacity. Animates in 100ms.
- **Tab drag-to-reorder**: tab lifts subtly (-2px Y), shadow appears, sibling tabs make room with 150ms shift.
- **Split drag handle**: cursor changes on hover; entire handle area highlights during drag; live preview of resize (no commit until release).
- **Hotkey hints**: in menus and modals, render as keycap chips: `⌘K`, `Ctrl+K`. Use platform-correct symbols.
- **Sidebar collapse**: 200ms slide; project rows transition from full to icon-only without flicker.
- **Project switch**: instant — no fade, no slide. The window contents swap. Active sidebar item updates with 100ms accent transition.
- **Pane spawn animation**: subtle 150ms scale-from-95% + fade-in. Once. Not on every focus.

---

## 8. Accessibility requirements

- WCAG 2.1 AA contrast on all text.
- Focus rings visible without relying on color alone (use offset + border).
- Every interactive element has hover, focus, active, disabled states.
- Modal traps focus; Esc always closes.
- All actions reachable by keyboard. Mouse-only flows are bugs.
- Screen reader labels on icon-only buttons.
- `prefers-reduced-motion` removes all transitions.

---

## 9. Platform-specific design

### macOS

- Traffic lights inset 12px from top-left, 18px from edge.
- No visible title bar background — content extends to top edge.
- System font fallbacks: SF Pro for UI, SF Mono for terminal (if user has them).
- Native menu bar (designed separately — flat list of menu items).

### Windows

- Custom in-window title bar, 32px tall.
- Window controls (─ ▢ ✕) right-aligned, 46px wide each, hover background.
- Drag region: title bar background (excludes interactive elements).
- System font fallbacks: Segoe UI Variable, Cascadia Mono.
- Hamburger menu in title bar exposes app menu (since native menu bar isn't a Windows convention for this kind of app).

---

## 10. What NOT to do

- No 3D effects, no parallax, no glass.
- No emojis in chrome (project icons use abstract glyphs only — terminal output may contain emoji, that's fine).
- No purple-pink gradients, no synthwave, no "AI" sparkles.
- No avatar / profile imagery (this is a local tool, not collaborative).
- No tooltips on every element — use them for icon-only buttons and truncated text only.
- No "Made with ❤️" anywhere.
- No skeuomorphic terminals (don't draw it like a 1980s monitor).

---

## 11. Constraints (technical)

- Single window. No multi-window in v0.1.
- Sidebar on the right (already locked).
- Designs must work at:
  - Min: 1024 × 640
  - Default: 1440 × 900
  - Large: 2560 × 1440 (4K) — verify density holds, no waste of space.
- No external image assets except: app icon, optional empty-state illustration (1 max).
- All other icons: lucide-react, phosphor, or hand-rolled SVG.

---

## 12. Deliverables

Produce, in this order:

1. **Color palette** — full token table with hex values, dark + light. One sentence rationale per accent decision.
2. **Typography spec** — font choices, sizes, weights, line heights.
3. **Spacing + radius scale** — final values committed.
4. **Wireframe set** (low-fidelity layout, structure only) for P0 components 1–9.
5. **High-fidelity mockups** (full visual treatment) for P0 components in dark theme.
6. **State variants** — for components that have multiple states (tab, pane, button).
7. **Light theme variants** — for components 1–4.
8. **Annotated specs** — sizing, spacing, color tokens labeled on each surface.
9. **Component inventory** — list all reusable atoms (button, input, badge, etc.) with their variants.

Output format: a single markdown document I can paste into Figma plugin / Pencil / hand off to engineers. Use ASCII diagrams when describing layout. Use color swatches as `▣ #xxxxxx — token.name — usage`.

---

## 13. Working agreement

- Make decisions, don't ask. If a decision is ambiguous, pick one and note it as `Decision: X (alternative considered: Y, rejected because Z)`.
- Stay opinionated. Don't average between references — pick one direction.
- If something I asked for is wrong (e.g., a color won't pass WCAG), tell me and propose the fix.
- Don't pad. If a section needs 3 sentences, write 3 sentences.
- Keep the whole spec under ~3000 words. We need it readable, not exhaustive.

Now design.
