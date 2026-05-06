# T6.5 — Add project flow

Manual smoke tests for the Add Project modal and its AppShell wiring.

## Scope

- `src/components/AddProjectModal/AddProjectModal.tsx`
- `src/components/AppShell/AppShell.live.dev.tsx` (sidebar `+ New project` → modal → IPC create + workspace register + activate)

## Standalone modal harness — `?wsdebug=addproject`

No Tauri runtime needed; pickers and submits are mocked.

1. **Render**: page loads with the modal already open. Title says "New project". Cancel + Create project buttons in the footer; Create is disabled while Name or Folder is empty.
2. **Name → glyph auto-derive**: type `argon`. The Preview glyph and the highlighted icon-grid cell switch to `AR`. Type `c`; preview becomes `CA`. Click an icon glyph (e.g. `OR`); typing more in Name no longer overrides it.
3. **Browse picker**: click "Browse…". Folder field is filled with the next mock path (`/Users/beqolozi/code/argon-web` …). Form is briefly disabled during the 120ms mock delay.
4. **Color**: click each swatch. The selected swatch shows a ring; the Preview icon background updates live.
5. **Validation**: clear Name, Create disabled. Clear Folder, Create disabled. Both filled, Create enabled.
6. **Submit success**: click Create project. Modal closes after ~250 ms; submission appears in the list panel below the harness header.
7. **Submit failure**: tick "Force backend error on submit", reopen the modal, fill the form, Create. The button shows "Creating…" then re-enables; an inline error renders under the form ("A project named …"); Name regains focus.
8. **Esc**: with the modal open, press Esc anywhere — including with a fake input focused. The modal closes. Pressing Esc while a submit is in flight is suppressed (the in-flight call is allowed to settle first).
9. **Backdrop click**: clicking outside the modal closes it. Clicking inside (e.g. on the Folder input) does not.
10. **Reopen reset**: open → fill → cancel → reopen. The form resets (Name empty, Folder empty, color back to swatch-1, error cleared, glyph back to auto-derive).

## AppShell harness — `?wsdebug=appshell`

Requires the Tauri dev window (PTY commands aren't available in a plain browser tab).

1. The three demo projects spawn and the modal is closed.
2. Click "+ New project" in the sidebar footer. The Add Project modal opens.
3. Enter a name like `qa-fresh-project`, click Browse… and pick a real folder, choose a swatch + glyph, hit Create project.
4. Expect: modal closes, the project appears at the end of the sidebar list, becomes the active project, and its single new pane shows `qa-fresh-project — fresh project. Try ls.` (the harness's startup echo).
5. Re-run step 2–4 with the same folder a second time. The backend rejects "duplicate name"; the error renders inline in the modal, the form re-enables, and the previous create is unchanged in the sidebar.
6. Open a real folder picker, then cancel it (Escape inside the native dialog). The Folder field is unchanged; no error toast.
7. With the modal open, press Esc. Modal closes; the previously-active project remains selected; no PTY churn.

## Persistence check

After a successful create:

- Reload the harness URL. The newly-created project's row in `projects` (SQLite) survives across launches — verify with the existing SQL inspection step in `qa/state-only-project-switching.md`. (T2.12 will surface this in the live UI; T6.5 only requires the row to exist.)
