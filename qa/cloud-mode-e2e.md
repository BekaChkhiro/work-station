# Cloud mode E2E smoke tests (T19.18)

Living matrix of **manual** end-to-end smoke tests for Phase 19 cloud
mode. Each scenario drives the full pipeline — desktop → IPC routing
layer (T19.6) → `WsBridgeClient` (T19.7) → Cloudflare Tunnel →
`cloud-agent` on the VPS (T19.2) — and verifies that the feature
behaves the same as its local counterpart.

> **Personal-use scope.** Acceptance for T19.18 is "every scenario
> below passes against a real paired VPS on each supported OS." Two
> machines (one macOS, one Windows) per `PROJECT_PLAN.md` §10 (T10.1
> was DROPPED). Linux is out (per `AGENTS.md` §3, hard rule 3).
>
> **Unit tests are not enough.** The routing layer, queue, banner,
> per-mode isolation, and each cloud-routed IPC wrapper are covered
> by Vitest in `src/ipc/transport.test.ts`,
> `src/integrations/cloudAgent/{client,queue}.test.ts`, and the per-
> wrapper `.test.ts` files. They stub `WsBridgeClient` — they do not
> exercise the wire. This matrix is what we use to find regressions
> the stubs can't see (cloudflared latency, token rotation, agent
> crashes, Solid effect re-entry under real network jitter).

## Prerequisites

### Paired VPS

The matrix assumes a working agent on the test machine's paired VPS,
provisioned per `docs/cloud-agent-vps.md`. Re-pair if the dot on the
Workspace toggle is amber/red before you start.

If you don't have an agent yet:

1. Provision the VPS (`docs/cloud-agent-vps.md`, T19.0).
2. Install the agent binary (`scripts/install-cloud-agent.sh`, T19.3).
3. Open **Settings → Cloud** (T19.15) and complete the pair flow.

Record the agent commit SHA in the matrix row's **Agent SHA** column
— the agent ships from the same monorepo, so `cloud-agent --version`
prints the same shape as the desktop.

### Build

Run a fresh dev build from the branch under test:

```bash
pnpm install            # if deps changed
pnpm tauri dev          # the build whose output you smoke-test
```

Record the commit SHA (`git rev-parse --short HEAD`) and the app
build mode (`dev` / `release`) in the matrix row's **App SHA** and
**Build** columns.

### Reset state between runs

Each scenario is independent. Between runs:

- Disconnect any active `pnpm tauri dev` window so the previous
  cloud-agent socket closes cleanly (otherwise the agent's connection
  cap fires "already connected" on re-pair attempts).
- The desktop's per-mode session/layout split (T19.17) means _local_
  state is unaffected by these runs — you do not need to wipe local
  SQLite.

## How to run

1. Launch Work Station via `pnpm tauri dev` (or a release bundle).
2. Confirm the Workspace toggle dot is green (paired, healthy).
3. Walk through each scenario below in order.
4. For each scenario, fill in the matrix row with `pass` / `fail`.
5. `fail` requires a paired `Notes` entry naming the symptom; open a
   tracking issue and reference it in the same cell.

Repeat per OS. Run the full matrix at least once per release
candidate, and any time the routing layer (`src/ipc/transport.ts`),
the cloud-agent client (`src/integrations/cloudAgent/`), or the
agent crate (`crates/cloud-agent/`) changes.

## Scenarios

### 1. Toggle: Local → Cloud → Local

Verifies the workspace toggle (T19.8) flips `cloudMode` (T19.5),
that the agent client (T19.7) auto-connects, and that the routing
layer (T19.6) starts dialing the agent on next IPC.

1. Start in **Local** mode (toggle highlights Local).
2. Click the **Cloud** segment.
3. Wait for the dot to settle green. The sidebar reloads to show the
   _cloud_ project list (T19.9 — different DB on the agent).
4. Click **Local**. Sidebar reverts to the local project list within
   one frame; no PTY churn on the cloud side (the agent's WS stays
   open per [`installCloudAgentAutoConnect`] until the next
   `cloud_mode=false` settles).

**Pass criteria:** sidebar project list swaps consistently, banner
(T19.16) never appears, no error toasts, both modes' sessions remain
intact (T19.17) when you flip back.

**Fail modes:**

- Cloud list never loads → check `cloud_agent_status.needsRepairAt`;
  if set, re-pair in Settings first.
- Cloud sessions vanish on toggle-back-to-cloud → T19.17 regression.

### 2. Pair a new agent from Settings

Verifies the Settings cloud pane (T19.15) writes URL + keychain
token, primes `cloud_agent_status`, and the toggle observes the new
state without restart.

1. **Settings → Cloud → Unpair** (if a pairing already exists). The
   Workspace toggle dot turns gray; clicking Cloud opens Settings.
2. Run `cloud-agent token rotate` on the VPS to produce a new
   pairing token. Copy the URL + token block.
3. Paste into **Settings → Cloud → Pair**. Click **Pair**.
4. Settings shows "Paired — last handshake at HH:MM:SS".
5. Workspace toggle dot turns green.
6. Click Cloud. The agent's project list loads.

**Pass criteria:** no app reload required, the keychain entry exists
afterwards (`Integration.CloudAgent` / `DEFAULT_ACCOUNT`), and the
toggle reflects the new pairing within ~1s of Settings closing.

**Fail modes:**

- Token survives Unpair → keychain delete didn't fire; check
  `setCloudAgentUrl(null)` path in Settings UI.
- Dot stays amber after pair → handshake succeeded but
  `lastHandshakeAt` wasn't stamped; check T19.7
  `onState('open')` hook.

### 3. Projects CRUD via cloud-agent

Verifies the Projects bridge (T18.4 + T19.9 cloud routing).

In **Cloud** mode:

1. Click **+ New project** in the sidebar.
2. Name the project `cloud-smoke-N` (where N is run count). Browse
   for a folder — the picker uses the _agent's_ filesystem (T19.11).
   Pick `/home/wsagent/code/cloud-smoke-N` (create it via SSH if
   missing).
3. Submit. The project lands in the sidebar, becomes active, and a
   fresh pane prompt appears (cwd = the path you picked, **on the
   VPS**).
4. Edit the project (rename, change color). Refresh the app. The
   change persists — it landed in the agent's SQLite.
5. Delete the project. The pane closes; sidebar drops the row.
6. Flip to **Local**. The project is **not** in the local list.

**Pass criteria:** every CRUD operation round-trips through the
agent's `projects` SQLite. Local SQLite is unchanged.

### 4. PTY sessions via cloud-agent

Verifies T19.10 (PTY cloud routing) and T18.3 (PTY bridge).

In **Cloud** mode, with a cloud project active:

1. Open a fresh pane. Confirm the prompt is on the VPS:
   ```bash
   hostname
   ```
   Should print the VPS hostname, **not** the desktop's.
2. Run a TUI:
   ```bash
   htop
   ```
   Verify ANSI colors render, alt-buffer enters cleanly. Quit with
   `q` — prior buffer restores.
3. Run a streaming command:
   ```bash
   for i in 1 2 3 4 5 6 7 8 9 10; do echo "cloud $i"; sleep 1; done
   ```
   While running, drag-resize the pane. The kernel re-flows output
   on the VPS; the renderer redraws without scrambling.
4. With the loop still running, click **Local** in the toggle, wait
   3s, click **Cloud** again. Per T19.17 the cloud pane re-attaches
   with full scrollback (every `cloud N` line that printed during
   the absence is present).
5. Close the pane. Sidebar session badge for the cloud project
   drops to 0.

**Pass criteria:** real binary IPC over WS (no escape-sequence
garbling), resize redelivers to the remote PTY, scrollback replay on
re-attach contains hidden-period output.

### 5. Filesystem operations via cloud-agent

Verifies T19.11 (FS routing) and T19.12 (Monaco remote files).

In **Cloud** mode:

1. Open the file tree (T13.2). The tree lists files from the cloud
   project's path **on the VPS**.
2. Open `README.md` (create it via the PTY first if missing). The
   Monaco editor loads remote content.
3. Edit a line. The debounced save (T13.4) writes to the VPS within
   ~500 ms — confirm via the PTY:
   ```bash
   tail -1 README.md
   ```
   The edit appears.
4. Change the file via the PTY (`echo "external" >> README.md`).
   The conflict-detection prompt (T13.5) fires in Monaco.
5. Try a write to a path outside the project root from Monaco — the
   agent's path-jail (T19.11) rejects it; an inline error renders.

**Pass criteria:** Monaco round-trips remote bytes; conflict
detection fires on external changes; path-jail rejections surface
as user-facing errors, not silent failures.

### 6. PlanFlow tasks via cloud-agent

Verifies T19.13 (PlanFlow cloud routing) — the desktop's PlanFlow
panel sources tasks/comments/activity from the agent's PlanFlow API
client rather than the desktop's.

In **Cloud** mode, with a cloud project linked to a PlanFlow
workspace (link via Settings → Integrations on the agent's side, or
re-use a project that's already linked):

1. Open the **Tasks** tab in the project workspace (T11.1).
2. Task list loads from the agent. Status groups render (T12.3).
3. Click a TODO task → **Start**. The task flips to IN_PROGRESS;
   a comment is added. Refresh — the change persists.
4. Click **Progress…**, add a note, submit. The comment appears in
   the activity feed (T12.7) within ~1s.
5. Click **Done**, add a summary, confirm. Task flips to DONE.
6. Flip to **Local**. The cloud project is gone from the sidebar
   (different project DB), so the cloud PlanFlow data is invisible.
   This is **expected** — local and cloud are separate workspaces.

**Pass criteria:** every PlanFlow mutation hits the agent's HTTP
client (not the desktop's). The desktop's PlanFlow Bearer token is
**not** used for cloud-routed PlanFlow ops; the agent's is.

### 7. System monitor via cloud-agent

Verifies T19.14 (system monitor cloud routing) and T18.5.

In **Cloud** mode:

1. Open the System monitor view (T18.5 on mobile / desktop
   equivalent). The CPU + RAM bars reflect the **VPS** load.
2. SSH into the VPS, run `stress -c 2 -t 30` (or similar). The
   bars climb within ~2s.
3. Flip to **Local**. The bars now reflect the desktop's load. The
   stress test on the VPS is not visible in Local.

**Pass criteria:** numbers track the source machine; switching
modes swaps the source within one poll interval.

### 8. Connection loss banner + offline queue

Verifies T19.16. The agent dropping mid-session must surface a
banner; user actions that can be queued (PlanFlow mutations,
filesystem writes that are idempotent) are buffered and replayed on
reconnect.

In **Cloud** mode, with a cloud project + open pane + open Monaco
file:

1. On the VPS, run:
   ```bash
   sudo systemctl stop cloud-agent
   ```
2. Within ~`DEFAULT_CLOUD_WAIT_MS` (5 s), the banner appears:
   **"Cloud agent disconnected — retrying…"**. The Workspace
   toggle dot turns amber.
3. The PTY pane shows the last frame; new keystrokes are **not**
   buffered (PTY input is realtime, not queued — this is by design;
   the banner notes "Some actions are paused").
4. Edit a Monaco file. The status indicator shows "Queued for
   sync".
5. Click **Progress…** on a PlanFlow task → enqueued.
6. On the VPS:
   ```bash
   sudo systemctl start cloud-agent
   ```
7. Within ~1 s, the banner switches to **"Reconnected — syncing
   queued changes"**. Within ~5 s the queue drains: the Monaco file
   shows "Synced" and the PlanFlow comment lands.
8. PTY pane reconnects via T19.10 scrollback replay; the prompt is
   live again.

**Pass criteria:** banner is the only error surface (no toast
spam), queued ops replay in order, no duplicate writes, no data
loss on the Monaco file. The desktop does **not** silently fall
back to local data.

### 9. Pairing expiry / needs-repair

Verifies T19.7's `CLOUD_AGENT_AUTH_FAILED_CODE` handling and the
Workspace toggle's `needs-repair` state.

1. On the VPS, run `cloud-agent token revoke` (revokes the current
   pairing token but leaves the agent running).
2. The current WS session terminates with close code `4401`. The
   banner appears, then re-routes to **"Pairing expired — re-pair
   in Settings"**.
3. Workspace toggle dot turns red; tooltip reads "Cloud — pairing
   expired".
4. Click Cloud → Settings opens, jumps to the Cloud pane (T19.15
   `onRequestPair` wiring).
5. Re-pair with a new token. Banner clears.

**Pass criteria:** the close code is mapped to `needs-repair`
(not generic "closed"), and the toggle CTA leads the user to the
fix without them having to know how to find the Settings page.

### 10. Per-mode session and layout isolation

Verifies T19.17 — local and cloud get separate session/layout
namespaces so that switching modes does not destroy the other
mode's state.

1. In **Local** mode, open a project, split into two panes, run a
   long command in each.
2. Switch to **Cloud**. The local panes disappear from view.
3. In Cloud, open a different project (or the same name; the agent's
   project is distinct), split into two panes, run commands.
4. Switch back to **Local**. The local panes are back, with the
   commands still running, scrollback intact.
5. Switch to **Cloud** again. The cloud panes are back, scrollback
   intact.
6. Quit and relaunch the desktop. Both modes restore their last
   layouts (Local from local SQLite, Cloud from the agent's SQLite).

**Pass criteria:** zero cross-contamination. Closing a tab in Local
does not close a tab in Cloud, even if their session IDs collide
between SQLites (the per-mode namespace keeps them disjoint).

## Matrix

Per-scenario results. Each row is one (scenario × OS) cell. Columns:

- **Date** — UTC date of the run (`YYYY-MM-DD`).
- **App SHA** — `git rev-parse --short HEAD` of the desktop build.
- **Agent SHA** — `cloud-agent --version` shortened to 7 chars.
- **Build** — `dev` (`pnpm tauri dev`) or `release` (`pnpm tauri build`).
- **Result** — `pass` / `fail`.
- **Notes** — required when Result is `fail`; name the symptom and
  link the tracking issue.

### 1. Toggle: Local → Cloud → Local

| OS      | Date | App SHA | Agent SHA | Build | Result | Notes |
| ------- | ---- | ------- | --------- | ----- | ------ | ----- |
| macOS   |      |         |           |       |        |       |
| Windows |      |         |           |       |        |       |

### 2. Pair a new agent from Settings

| OS      | Date | App SHA | Agent SHA | Build | Result | Notes |
| ------- | ---- | ------- | --------- | ----- | ------ | ----- |
| macOS   |      |         |           |       |        |       |
| Windows |      |         |           |       |        |       |

### 3. Projects CRUD via cloud-agent

| OS      | Date | App SHA | Agent SHA | Build | Result | Notes |
| ------- | ---- | ------- | --------- | ----- | ------ | ----- |
| macOS   |      |         |           |       |        |       |
| Windows |      |         |           |       |        |       |

### 4. PTY sessions via cloud-agent

| OS      | Date | App SHA | Agent SHA | Build | Result | Notes |
| ------- | ---- | ------- | --------- | ----- | ------ | ----- |
| macOS   |      |         |           |       |        |       |
| Windows |      |         |           |       |        |       |

### 5. Filesystem operations via cloud-agent

| OS      | Date | App SHA | Agent SHA | Build | Result | Notes |
| ------- | ---- | ------- | --------- | ----- | ------ | ----- |
| macOS   |      |         |           |       |        |       |
| Windows |      |         |           |       |        |       |

### 6. PlanFlow tasks via cloud-agent

| OS      | Date | App SHA | Agent SHA | Build | Result | Notes |
| ------- | ---- | ------- | --------- | ----- | ------ | ----- |
| macOS   |      |         |           |       |        |       |
| Windows |      |         |           |       |        |       |

### 7. System monitor via cloud-agent

| OS      | Date | App SHA | Agent SHA | Build | Result | Notes |
| ------- | ---- | ------- | --------- | ----- | ------ | ----- |
| macOS   |      |         |           |       |        |       |
| Windows |      |         |           |       |        |       |

### 8. Connection loss banner + offline queue

| OS      | Date | App SHA | Agent SHA | Build | Result | Notes |
| ------- | ---- | ------- | --------- | ----- | ------ | ----- |
| macOS   |      |         |           |       |        |       |
| Windows |      |         |           |       |        |       |

### 9. Pairing expiry / needs-repair

| OS      | Date | App SHA | Agent SHA | Build | Result | Notes |
| ------- | ---- | ------- | --------- | ----- | ------ | ----- |
| macOS   |      |         |           |       |        |       |
| Windows |      |         |           |       |        |       |

### 10. Per-mode session and layout isolation

| OS      | Date | App SHA | Agent SHA | Build | Result | Notes |
| ------- | ---- | ------- | --------- | ----- | ------ | ----- |
| macOS   |      |         |           |       |        |       |
| Windows |      |         |           |       |        |       |

## When to re-run

- Before each `v0.x` tag that includes Phase 19 changes.
- After any change touching `src/ipc/transport.ts`,
  `src/integrations/cloudAgent/`, `src/integrations/wsBridge/`, or
  any per-wrapper cloud branch (`src/ipc/{pty,fs,files}.ts`,
  `src/integrations/planflow/client.ts`).
- After any change to the `cloud-agent` crate
  (`crates/cloud-agent/`).
- After bumping the `WsBridgeClient` ping/reconnect constants — the
  banner timing is observable here.
- After OS upgrades on the dev machines (macOS / Windows feature
  update).

Older results stay in the matrix as audit trail until the next full
re-run overwrites them. Don't delete a `fail` row without linking
the fix's PR or commit SHA in the new row's `Notes`.

## Out of scope (deferred)

- Automated E2E via Playwright driving a real agent — would need a
  CI VPS and credential management. Phase 19.x stretch.
- Multi-agent pairing — v0.1 is one paired agent at a time; the
  Settings UI enforces this. Phase 20 candidate.
- Chaos/latency injection — would need a `tc netem` harness on the
  VPS. Defer until a flake surfaces that we can't reproduce by
  hand.
