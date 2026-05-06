# T6.8 — Projects empty state QA

## Setup

1. `pnpm tauri dev` — wait for the app window to open.
2. Navigate to `http://localhost:1420/?wsdebug=projectsempty` (the URL the
   harness exposes — see `src/App.tsx`).

## Acceptance checks

- **Empty state renders**: Centred card with folder glyph, "Welcome to
  Work Station" headline, supporting copy, and an accent CTA labelled
  "Add your first project" with a `⌘N` hint.
- **CTA opens add flow**: Clicking the CTA opens the Add Project modal
  (T6.5). Submitting a valid form persists a row via `createProject` and
  the harness banner reports the new name.
- **Keyboard accessible**: Tab focus reaches the CTA; Enter / Space
  activate it (autofocus is set on first mount). Focus ring is visible.
- **Esc closes the modal** without dismissing the empty state.

## AppShell wiring

- Open `?wsdebug=appshell` and let the demo projects seed. Right-click →
  Delete each project and confirm the destructive modal three times. After
  the last project is removed the workspace area should swap to the
  empty state automatically (sidebar still renders with its `New project`
  footer button).
- Pressing the empty-state CTA or the sidebar `New project` button both
  open the same Add Project modal.
- Adding a project from the empty state immediately swaps back to the
  per-project workspace view.

## Visuals (dark + light)

- Toggle theme via OS appearance setting. Both themes should preserve
  contrast: title primary, subtitle secondary, CTA on accent with
  `#07181c` text matching other primary buttons.
