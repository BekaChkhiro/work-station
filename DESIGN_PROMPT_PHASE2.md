# Claude Design Prompt — Work Station (Phase 2: completion)

> Paste this into Claude after attaching `work-station-design/` (the existing prototype). This prompt **extends** the existing prototype — it does NOT start from scratch.

---

You are continuing work on **Work Station**, a desktop hub for managing AI-CLI terminal sessions across projects. A working prototype already exists in `work-station-design/`:

- `Work Station.html` — entry, loads React UMD + scripts
- `app.jsx` — root `<App/>`, state, keyboard shortcuts, tweaks panel wiring
- `components.jsx` — TitleBar, TabStrip, Pane, LayoutNode, Sidebar, QuickSwitcher, AddProjectModal, icons
- `styles.css` — design tokens (OKLCH, dark + light), all component styles
- `data.js` — `WS_PROJECTS`, `WS_CLIS`, `WS_ICONS`, `WS_SWATCHES`
- `tweaks-panel.jsx` — live editor (theme, OS, accent, density, sidebar width)

This prototype covers ~80% of the v0.1 design. Your job: ship the remaining **20%** while preserving the existing visual language exactly.

---

## 0. Hard rules — do not break

1. **Do not regenerate existing files from scratch.** Edit and append. Existing tokens, classes, and components must keep working.
2. **Reuse, don't reinvent.** Use the existing `Icon`, `Kbd`, `MacTraffic`, `WinControls` components. Use existing CSS variables (`--bg-canvas`, `--accent`, `--text-secondary`, etc.). Do not introduce a new color system.
3. **Match the established pattern.** New components follow the same JSX style as `Sidebar` / `QuickSwitcher`. New CSS follows the BEM-ish flat-class convention already in `styles.css`.
4. **Stay opinionated, single direction.** No options menus inside the design itself — pick one treatment and commit.
5. **No motion creep.** Reuse `--ease` and existing 150–200ms timings. No new spring physics, no parallax.
6. **Demo data lives in `data.js`.** Add new fixtures (settings, errors, hotkeys list) there — keep components prop-driven and stateless where possible.

---

## 1. Components to add (in priority order)

For each: extend `components.jsx`, add CSS to `styles.css`, wire from `app.jsx`, add demo data to `data.js`.

---

### 1.1. Split resize handle — drag interaction (P0)

**Current state:** `LayoutNode` renders a static 6px `.split-h` / `.split-v` divider. No drag.

**What to add:**

- Real drag-resize. The divider becomes a drag handle that adjusts its parent split's ratio.
- The split node gains a `ratio` field (default `0.5`). Layout's grid template becomes `${ratio}fr 6px ${1 - ratio}fr`.
- During drag: live preview, no commit until release.
- Constraints: minimum 200px per child pane.
- Double-click handle: snap to 0.5.

**Visual states:**

| State | Treatment |
|---|---|
| Idle | 1px hairline (`--border-default`), 6px hit-area |
| Hover | 2px tinted line (`--accent-muted` at 40% opacity), cursor `ew-resize` / `ns-resize` |
| Dragging | 4px tinted line (`--accent` solid), full pane area shows live ratio |
| Snap-near-50% | Brief 100ms pulse on handle when ratio enters 48–52% range |

**Demo:**

In `data.js`, the existing `argon` project's first tab has nested splits. Add a `ratio` property to each split node. `app.jsx` should mount a stateful wrapper so dragging persists for the session.

---

### 1.2. CLI dropdown per pane (P0 — T7.3)

**Current state:** `Pane` has a `pane-menu` button (⋯) that does nothing useful. There is no "+ New terminal" affordance inside a pane area.

**What to add:**

A **CLI launch popover** that opens from:
- The `+` button on a tab strip's "+" → adds new tab with chosen CLI
- A new `+` icon button inside the pane header (right of cwd, left of status) → replace pane CLI
- Keyboard ⌘T → opens popover anchored to focused pane

**Popover content:**

```
┌─────────────────────────────────────┐
│  Spawn in pane             ⌘T       │  ← muted header
├─────────────────────────────────────┤
│  ● Claude Code      v0.7.2  ⌘1      │  ← CLI rows
│  ● Kimi             v0.4.1  ⌘2      │
│  ● codex            v1.0.3  ⌘3      │
│  ● zsh              5.9             │
│  ● bash             5.2.21          │
│  ● PowerShell       7.4.4           │
├─────────────────────────────────────┤
│  + Add custom CLI…       (disabled) │  ← Phase 11
└─────────────────────────────────────┘
```

- Width: 280px.
- Keyboard nav: ↑↓ + Enter, ⌘1–9 for first 9 entries, Esc closes.
- Each row: dot (CLI color) + name + version (muted, mono) + optional shortcut on right.
- Hover and selection use `--bg-hover` / `--accent-soft`.
- The custom CLI footer row is greyed and shows tiny "v0.2" tag.

---

### 1.3. Settings page (P0 — T8.7)

**Current state:** Cog icon in titlebar and sidebar are no-ops.

**What to add:**

A full **in-window page** (not modal). It replaces the workspace area when active. Open via cog buttons or ⌘,. Close via top-left "← Back to {project.name}" button or Esc.

**Layout:**

```
┌─────────────────────────────────────────────────────────────────┐
│  ← Back to argon-web                                            │  ← header bar (32px)
├─────────────┬───────────────────────────────────────────────────┤
│  General    │  General                                          │
│ ▣Appearance │                                                   │
│  Keybinds   │  Telemetry                                        │
│  CLIs       │   ☐ Send anonymous performance metrics            │
│  Privacy    │   Helps us optimize cold start and memory usage.  │
│  About      │   No command or output content is ever sent.      │
│             │                                                   │
│             │  ───────────────────────────────────────────────  │
│             │                                                   │
│             │  Default fallback CLI                             │
│             │   [zsh ▾]                                         │
│             │   Used when a project's default CLI isn't found.  │
│             │                                                   │
│             │  Scrollback per session                           │
│             │   [────●──────────] 4 MB                          │
│             │   Larger means more history, more memory.         │
└─────────────┴───────────────────────────────────────────────────┘
```

- Left rail: 200px, sections list, current section has accent left-border + tinted bg.
- Right pane: max-width 640px content, generous padding (24px sides, 20px between groups).
- Each setting: label (13px, `--text-primary`), control on right or below, optional 12px hint in `--text-tertiary`.
- Group separator: `--border-subtle` 1px, 24px vertical margin.

**Sections to populate:**

1. **General**
   - Telemetry toggle (also lives in Privacy — single source, mirror UI)
   - Default fallback CLI (dropdown)
   - Scrollback per session (slider 1–16 MB, default 4)
   - "Open at login" toggle (disabled with "v0.2" badge)

2. **Appearance**
   - Theme (radio: Dark / Light / System) — sample swatches next to each
   - Accent (swatches: teal/lime/violet/amber, current highlighted)
   - UI font (radio: Geist / Inter / System)
   - Mono font (radio: JetBrains Mono / Geist Mono / Berkeley Mono / System)
   - UI font size (slider 12–16px, default 13)
   - Density (radio: Compact / Comfortable)

3. **Keybindings**
   - Search input on top
   - Table of: Action label · Current binding (keycap chips) · Edit button (pencil icon)
   - Click Edit → row enters "press keys" mode (input captures keystroke, shows pending chips, "Save" / "Cancel")
   - Conflict detection: if new binding clashes, inline warning "Used by 'Close pane'"
   - "Reset to defaults" subtle text button at bottom

4. **CLIs**
   - List of detected CLIs from `WS_CLIS`: row with color dot, name, version, path (mono, muted)
   - "Refresh" button at top-right
   - "Add custom CLI…" disabled with "v0.2" badge

5. **Privacy**
   - Mirror of telemetry toggle
   - Crash reporting toggle (separate)
   - "View what we collect" expandable section listing exact event names
   - Link: "Privacy policy ↗"

6. **About**
   - App icon centered, "Work Station 0.1.0", build hash mono
   - Buttons: "Check for updates", "Open GitHub", "Open logs folder"
   - License: "MIT" + link

**Demo:** Add `WS_HOTKEYS` array to `data.js` with at least 12 actions covering Phase 8.2 spec.

---

### 1.4. Edit Project modal + Delete confirmation (P0 — T6.6)

**Current state:** Only Add Project modal exists.

**What to add:**

**Edit modal** — visually identical to Add Project, with these differences:
- Title: "Edit project"
- Primary button: "Save changes" (only enabled if dirty)
- Secondary destructive button bottom-left of footer: subtle red text-button "Delete project"
- Pre-filled with current values

**Delete confirmation modal** — smaller (~420px), opened on top of Edit modal:

```
┌──────────────────────────────────────────────┐
│                                              │
│       Delete "argon-web"?                    │
│                                              │
│       This project has 4 running sessions.   │
│       They will be killed.                   │
│                                              │
│       This cannot be undone.                 │
│                                              │
│              [ Cancel ]  [ Delete  ]         │  ← red destructive
│                                              │
└──────────────────────────────────────────────┘
```

- Centered, no header bar (or minimal).
- Cancel = ghost button, Delete = solid red (`--error` background, white text).
- Esc = Cancel. Enter = Delete (only after 500ms safety delay — visual: button shows tiny progress fill before becoming clickable).
- If `sessions === 0`: message simplifies to "This project has no running sessions." (no killed-sessions warning).

**Wire from:** A new "Edit" item in the sidebar project row's right-click context menu, AND from a pencil icon visible on hover at far right of sidebar row.

---

### 1.5. In-terminal search overlay (P0 — T4.10)

**Current state:** ⌘F not wired.

**What to add:**

A search overlay anchored to the **focused pane**, slides down from the top of the pane area:

```
┌──────────────────────────────────────────────┐
│  [🔍 search…       ] 3 of 18  ↑ ↓  Aa  .*  ✕ │
├──────────────────────────────────────────────┤
│  ...pane contents with highlighted matches...│
```

- Width: 380px max, anchored top-right of pane with 12px inset.
- Background `--bg-elevated` with `--shadow-popover`, `--r-md` radius, `--border-default` 1px border.
- Input: 13px, monospace, autofocus, ⌘F also focuses if already open.
- Match counter: "3 of 18" or "no matches" (in `--text-tertiary` when 0).
- ↑↓ arrows: round 22×22 ghost icon buttons.
- "Aa" toggle: case-sensitive, 22×22, active = tinted bg.
- ".*" toggle: regex, same dimensions.
- Close X: 22×22.

**Match highlight in terminal output:**
- Current match: `--accent-soft` background + `--accent` underline.
- Other matches: subtle `--border-strong` background, no underline.

**Behavior:**
- ⌘F: open or focus.
- Esc: close.
- Enter: next match. Shift+Enter: prev.
- ⌘G / ⌘Shift+G: next/prev (alt shortcuts).
- Closing the overlay clears all match highlights.

**Demo:** Add a small "search demo" toggle in tweaks panel that pre-fills "Compiled" as query against the `pnpm dev` pane in argon project.

---

### 1.6. Error states (P0)

Three distinct error treatments. Add demo toggles in tweaks panel for each.

#### 1.6.a — Pane spawn error (T2.15)

Replaces pane content when PTY failed to spawn:

```
┌──────────────────────────────────────────────────┐
│  ● Claude Code   ~/code/argon-web   error    ⋯  │  ← pane head (status: error)
├──────────────────────────────────────────────────┤
│                                                  │
│            ⚠   Couldn't start CLI                │
│                                                  │
│       claude: command not found in PATH          │  ← mono, muted
│                                                  │
│       The CLI may not be installed, or your      │
│       project's PATH may be missing the entry.   │
│                                                  │
│        [ Retry ]    [ Pick another CLI ]         │
│                                                  │
│              View install instructions ↗         │  ← subtle link
│                                                  │
└──────────────────────────────────────────────────┘
```

- Centered card inside pane area, max-width 420px.
- Icon: warning triangle in `--warning`.
- Headline: 14px semibold.
- Error message: 12px mono, `--text-secondary`.
- Body: 13px, `--text-secondary`.
- Buttons: ghost + ghost. Link below in `--text-tertiary`.

#### 1.6.b — Crash recovery banner (post-relaunch)

Slides in below titlebar after a crashed previous session:

```
┌────────────────────────────────────────────────────────────────────┐
│  ↻  Recovered from previous session. 3 sessions were re-spawned.   ✕ │
└────────────────────────────────────────────────────────────────────┘
```

- Height: 32px.
- Background: `--warning` at 12% opacity, top + bottom borders in `--warning` at 30%.
- Icon: refresh circle in `--warning`.
- Text: 12.5px, `--text-primary`.
- Right side: "View report" subtle link + close X.
- Auto-dismisses after 30s OR on user action.

#### 1.6.c — Toast (transient errors)

Top-right of window, slides in from right, stack vertically up to 3:

```
┌─────────────────────────────────────────────┐
│  ✕  Failed to save layout                   │
│  ┌─                                         │
│  Database is locked. Try again in a moment. │
│                       [ Retry ]    [ × ]    │
└─────────────────────────────────────────────┘
```

- Width: 360px.
- Auto-dismiss: 5s default; sticky if `action` provided.
- Icon: per type — error (`--error`), warning, info (`--info`), success (`--success`).
- Stack offset: 8px between toasts.
- Slides in from right with 200ms ease-out; slides out + fades in 150ms.

**Demo:** Tweaks panel "Trigger toast" buttons (one per type).

---

### 1.7. Loading / skeleton states (P0 — T8.9)

Two cases:

**1.7.a — Initial app shell** (before project list arrives):
- Sidebar: 5 placeholder rows, each with shimmering rectangle (icon position) + line (name) + tiny dot (badge).
- Workspace area: subtle "•" pulse centered, no content.
- Shimmer animation: 1.6s linear infinite, gradient sweep across rows.

**1.7.b — Pane mounting** (xterm.js initializing, before first output):
- Inside pane (after head): subtle dimmer "spawning…" text, animated 3 dots (⠋⠙⠹).
- 12px monospace, `--text-tertiary`.
- Replaced by terminal once first output arrives.

**Demo:** Tweaks panel toggle "Show skeleton" forces loading state for 4 seconds.

---

### 1.8. Onboarding flow — first launch (P1)

Three-screen sequence in a centered card (640×480 max), backdrop is the app shell at low opacity. Progress dots at bottom (3 dots, current is `--accent`).

**Step 1 — Welcome**

```
                  ▣
              Work Station

        A workspace for the terminals
              you actually use.

           [ Get started → ]
```

- App icon 64×64.
- Title 28px, semibold.
- Subtitle 14px, `--text-secondary`.
- Single primary button.

**Step 2 — Telemetry**

- Headline: "Help improve Work Station"
- Body: 2 short paragraphs explaining what's collected (perf, crashes), what's NOT (commands, output, paths).
- One toggle: "Send anonymous metrics" (default OFF — change later if D3 decides opt-out).
- Footer: "Continue" primary button. Subtle "Skip" text link.

**Step 3 — First project**

- Embeds the Add Project form inline (no modal chrome).
- Footer: "Create project" primary, "Maybe later" ghost.

**Skip path:** "Maybe later" or Esc closes the entire onboarding and shows the empty state.

**Demo:** Tweaks panel toggle "Show onboarding" replays the flow.

---

### 1.9. Update banner (P1, polish)

Already partially implemented. Polish pass:

- Make icon rotate 180° once when banner appears (200ms).
- Add subtle hover state for "Restart" button.
- Persist dismissal in `localStorage` for the prototype (so toggling tweak doesn't re-show).

---

### 1.10. Windows menu (P1 — completes T8.5)

**Current state:** Windows chrome shows only window controls; no native menu bar (per platform convention).

**What to add:**

Hamburger icon button on the **left** side of titlebar when `os === 'win'` (where mac shows traffic lights). Opens a menu mirroring the planned macOS menu bar:

```
File          ⌘N New project
              ⌘T New terminal
              ⌘W Close pane
             ─────────────
              ⌘, Settings
             ─────────────
              ⌘Q Quit
Edit          ⌘C Copy
              ⌘V Paste
              ⌘F Find in pane
View          ⌘B Toggle sidebar
              ⌘K Quick switcher
              ⌘1..9 Switch project
Help          About
              Documentation
              Report issue
```

- Menu width: 240px.
- Section headers: 11px `--text-tertiary` uppercase letterspacing 0.04em.
- Items: 28px tall, label left, shortcut right (mono, `--text-tertiary`).
- Hover: `--bg-hover`. Active: `--bg-active`.

**Mac equivalent:** Same items appear in the (separate) macOS native menu bar. The design only needs to render the Windows hamburger version — note in a comment that mac uses the OS-level menu bar.

---

### 1.11. Tooltip system (P1, polish)

A thin tooltip primitive used by icon-only buttons across the app.

- Trigger: 600ms hover delay.
- Position: above by default, flips to below if no room.
- Background `--bg-elevated`, `--border-default`, `--shadow-popover` (smaller variant).
- Padding: 6px 8px, font-size 11.5px, `--text-primary`.
- Optional shortcut chip on the right inside the tooltip.

Apply to: titlebar icon buttons, sidebar settings cog, pane menu, search overlay icons.

---

## 2. CSS additions to `styles.css`

Add at the end of the file under a `/* === Phase 2 additions === */` banner. Group by component. Reuse existing tokens — do not add new color variables unless absolutely needed.

If a new token is unavoidable, propose it and add to BOTH dark and light theme blocks.

---

## 3. New demo data in `data.js`

Add the following arrays/objects:

```js
window.WS_HOTKEYS = [
  { id: 'new-tab',         label: 'New terminal',          binding: ['⌘', 'T'] },
  { id: 'split-v',         label: 'Split vertical',         binding: ['⌘', '\\'] },
  { id: 'split-h',         label: 'Split horizontal',       binding: ['⌘', '⇧', '\\'] },
  { id: 'close-pane',      label: 'Close pane',             binding: ['⌘', 'W'] },
  { id: 'switcher',        label: 'Quick switcher',         binding: ['⌘', 'K'] },
  { id: 'find',            label: 'Find in terminal',       binding: ['⌘', 'F'] },
  { id: 'find-cross',      label: 'Find across sessions',   binding: ['⌘', '⇧', 'F'] },
  { id: 'settings',        label: 'Settings',               binding: ['⌘', ','] },
  { id: 'project-1',       label: 'Switch to project 1',    binding: ['⌘', '1'] },
  { id: 'project-2',       label: 'Switch to project 2',    binding: ['⌘', '2'] },
  { id: 'toggle-sidebar',  label: 'Toggle sidebar',         binding: ['⌘', 'B'] },
  { id: 'new-project',     label: 'New project',            binding: ['⌘', 'N'] },
];

window.WS_SETTINGS = {
  telemetry: false,
  crashReports: true,
  fallbackCli: 'zsh',
  scrollbackMb: 4,
  uiFont: 'Geist',
  monoFont: 'JetBrains Mono',
  uiSize: 13,
  density: 'comfortable',
  theme: 'dark',
  accent: 'teal',
};

window.WS_DEMO_ERRORS = {
  paneSpawnError: {
    cli: 'claude',
    message: "claude: command not found in PATH",
    cwd: "~/code/argon-web",
  },
  toastSamples: [
    { type: 'error',   title: 'Failed to save layout', body: 'Database is locked. Try again in a moment.', action: 'Retry' },
    { type: 'warning', title: 'CLI not found',         body: 'Falling back to zsh for new panes.' },
    { type: 'info',    title: 'Update available',      body: 'v0.7.3 is ready.', action: 'Restart' },
    { type: 'success', title: 'Project created',       body: 'lumen-marketing is ready.' },
  ],
};
```

---

## 4. Tweaks panel — new toggles

Append to the existing tweaks panel, under a new "Demo states" section:

- Toggle: "Show settings page" — replaces workspace with settings.
- Toggle: "Show onboarding" — overlays the onboarding flow.
- Toggle: "Show pane error" — argon's `p1` becomes the error state.
- Toggle: "Show crash banner" — banner appears below titlebar (existing update banner stays separate).
- Toggle: "Show search overlay" — opens with pre-filled query in focused pane.
- Toggle: "Show skeleton loaders" — sidebar + workspace go to skeleton for 4s.
- Button row: "Trigger error toast", "Trigger info toast", "Trigger success toast".

These toggles should not interfere with each other — each surfaces independently.

---

## 5. Acceptance — what "done" looks like

The Phase 2 design is done when ALL of these are true:

- [ ] Drag a split handle in argon's first tab — ratio updates live, releases commit. Double-click snaps to 50%.
- [ ] Click "+" in tab strip → CLI dropdown opens. Pick Kimi → new tab created with kimi pane.
- [ ] ⌘, opens Settings. All 6 sections render. Hotkey rebinder shows pending state and conflict warning.
- [ ] Right-click sidebar project → Edit. Modify name → Save enables. Click Delete → confirm modal with session count. Delete with safety delay works.
- [ ] ⌘F in focused pane → search overlay slides in. Type "Compiled" → matches highlight, current highlighted distinctly. Esc closes.
- [ ] All 3 error treatments visible via tweaks panel. Toasts stack and auto-dismiss correctly.
- [ ] Skeleton loaders shimmer; pane mounting shows pulse.
- [ ] Onboarding 3 steps navigate forward + back; skip works; final step creates a project that lands in sidebar.
- [ ] Update banner polish in place.
- [ ] Windows hamburger menu opens (toggle OS to win in tweaks); items render correctly.
- [ ] Tooltips appear on titlebar icons after 600ms hover.
- [ ] All new states work in both dark + light themes.
- [ ] All new states respect `prefers-reduced-motion`.
- [ ] No existing component or token has changed in a breaking way (existing prototype still works as before).

---

## 6. Working agreement

- Make decisions, don't ask. Note them as `// Decision: X (alt: Y, rejected: Z)` in code comments where ambiguous.
- Don't introduce new icons unless lucide-style and inline SVG. Match existing `Icon` component pattern.
- Don't introduce new fonts.
- Don't add gradients to chrome. Subtle shadows OK (`--shadow-popover`, `--shadow-modal`).
- Keep new CSS under ~600 lines total. If you need more, you're over-engineering — simplify.
- After you finish, output a short delta report:
  - Files changed
  - New components exported
  - New CSS variables (should be 0 ideally)
  - Any deviations from the spec and why

Now ship Phase 2.
