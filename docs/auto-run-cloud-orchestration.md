# Auto-run cloud orchestration — design plan

**Goal:** let the user start an auto-run queue in **Cloud** mode, **close the
desktop app**, and have the cloud-agent VPS keep dispatching tasks through the
queue on its own — finishing each task, verifying its PR merge, and dispatching
the next, all with no desktop connected.

This is **not** how it works today. This doc captures the gap and the migration.

---

## 1. Current architecture (why closing the app freezes the queue)

The auto-run "brain" lives **entirely in the desktop renderer**:

| Concern                                  | Where it runs today                                                                                                                                   | On app close                      |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| tick loop (`setInterval`)                | renderer / `window` — `src/stores/autoRunQueue.ts:170` (`ensureTickStarted`)                                                                          | ❌ dies                           |
| queue state (`planflow_auto_run_queues`) | **local** desktop SQLite `app_settings` — `src/db/settings.ts:178` calls `db()` directly, never routed to the agent                                   | ❄️ frozen locally                 |
| poll task → DONE                         | renderer polls PlanFlow (`pollRunning`)                                                                                                               | ❌ stops                          |
| pick + dispatch next                     | renderer (`pickAndDispatch` → `startTask` → `launchTaskCli`)                                                                                          | ❌ stops                          |
| PR-merge verify                          | renderer (`pollMergeStatus`, `createRendererGitHubClient`, reads local `.git/config`)                                                                 | ❌ stops                          |
| PTY reap on task done                    | renderer (`ptyKill` in `completeCurrent`)                                                                                                             | ❌ stops → orphan claudes pile up |
| **the claude agent PTY itself**          | **cloud-agent VPS** — `PtyManager` is daemon-lived `Arc`, `Connection::drop` only aborts output forwarders (`crates/cloud-agent/src/dispatch.rs:178`) | ✅ **keeps running**              |

The cloud-agent is a dumb executor. Its WS frame whitelist
(`crates/cloud-agent/src/dispatch.rs:347`) is only: `pty_*`, `fs_*`,
`planflow_*` proxy, `project*`, `settings_*`. **No queue / orchestration
frame exists.**

### Live VPS evidence (2026-05-25, `ws-cloud-agent-dev`, 116.203.92.40)

- `load average: 0.00` (idle, desktop disconnected) yet **2× `claude` + 2×
  `planflow-mcp` + `bash` still parented under `cloud-agent`** → PTYs genuinely
  survive disconnect.
- `Memory: 5.1G (peak: 6.8G)` on a 7.7 GB box → orphan agents from finished
  tasks never reaped (the reaper is in the desktop). Matches the warning in
  `autoRunQueue.ts:347`.

**Net behaviour today:** close the app mid-queue → the _current_ task's agent
keeps running (may even finish + mark DONE + open PR), but **the next task is
never dispatched**, orphans accumulate, RAM creeps. Reopen the app →
`hydrateAutoRunQueues()` re-arms the loop and _catches up_, but no progress
happened while closed.

---

## 2. Target architecture

Move the orchestration loop **into the cloud-agent** so it runs server-side,
independent of the desktop. The desktop becomes a thin control + display client
in cloud mode; **local mode keeps the existing in-renderer loop unchanged.**

```
            ┌──────────────────────── desktop (renderer) ────────────────────────┐
 cloud mode │  AutoRunBar / AutoRunDialog  →  auto_run_* WS frames  →  (display)   │
            └─────────────────────────────────────────────────────────────────────┘
                                          │ WS (control plane only)
                                          ▼
            ┌──────────────────────── cloud-agent (VPS, daemon) ──────────────────┐
            │  auto_run table (SQLite)                                             │
            │  orchestrator tokio task  ── ticks every 20s, survives disconnect ── │
            │     pick → dispatch (PtyManager) → poll PlanFlow → verify PR → reap  │
            │  internal PlanFlow client (per-project token)                        │
            │  internal GitHub client (new per-project token store)               │
            └─────────────────────────────────────────────────────────────────────┘
```

Key property: the orchestrator calls the agent-internal `PtyManager` and
PlanFlow/GitHub clients **directly, no WS round-trip** — so it runs with the
desktop fully offline.

---

## 3. Work breakdown

> **Status: Phase A DONE** (cloud-agent builds, clippy-clean, 181 tests pass).
> Added: `migrations/0004_auto_run_queues.sql`, `src/db/auto_run.rs` (store),
> `src/auto_run/{mod,orchestrator}.rs` (tick loop + state machine), public
> `PlanflowState::{list_tasks,start_work,update_task_status}`, orchestrator
> wired into `server.rs::spawn`. `verifying_merge` advances immediately
> (Phase D stub); task-status write-back on timeout/failure deferred (Phase D);
> external id read from the queue row (Phase B will resolve via `project_links`).
> PTY spawn inherits the daemon env (`config.env` overlays) so `claude`
> resolves on the VPS PATH — but `planflow-mcp` at `~/.npm-global/bin` is NOT on
> systemd's default PATH; the operator must extend the service PATH or rely on
> claude's MCP config using an absolute path (see §6).
> **Nothing seeds a queue yet — that needs Phase B (WS frames).**

### Phase A — agent-side orchestrator core (Rust)

1. **Queue store.** New table `auto_run_queues` in the agent DB
   (`/var/lib/cloud-agent/cloud-agent.db` — note: NOT `db.sqlite3`; the
   runbook path in `qa/planflow-cloud-start.md` is stale), one row per
   `(project_id)`, mirroring
   the `AutoRunQueue` shape (`src/types/autoRunQueue.ts:61`). Survives daemon
   restart. New module `crates/cloud-agent/src/auto_run/store.rs`.
2. **Orchestrator task.** Long-lived `tokio` task spawned at daemon startup
   (`server.rs` next to the system-stats sampler). Ticks every
   `AUTO_RUN_POLL_INTERVAL_MS` (20s). Per active queue, port the state machine
   from `advance()`: `scheduled` / `waiting` / `running` / `verifying_merge`.
   Re-implement `pickNextTaskId`, `pollRunning`, `pickAndDispatch`,
   `completeCurrent`, `pollMergeStatus`, and the PTY reap.
3. **Server-side task dispatch.** This is the biggest port. Today
   `startTask` (`src/integrations/planflow/startTask.ts`) +
   `startTaskCliLauncher` (`src/components/AppRoot/AppRoot.tsx:1261`) run in the
   renderer. Server-side the orchestrator must:
   - `POST /work` + flip `IN_PROGRESS` + fetch branch-name (internal PlanFlow
     client) — straightforward.
   - resolve a CLI (port `resolveTaskCli`; on the VPS this is just `claude`).
   - spawn a PTY in the project via `PtyManager`.
   - write the start prompt + CR with idle-aware timing — port
     `writePromptWhenReady` (`AppRoot.tsx:1341`, idle 600ms / max 2.5s).
   - The prompt literal is trivial to port:
     `formatPlanFlowStartPromptForMode` (`src/types/planflowStartMode.ts:67`).

### Phase B — control-plane WS frames

> **Status: Phase B DONE** (cloud-agent + workstation-core build, clippy-clean,
> 196 cloud-agent tests + 26 protocol tests pass). Added `ClientMessage`
> variants `auto_run_start/stop/pause/resume/status` (+ `KNOWN_CLIENT_TYPES`),
> `ServerMessage::auto_run_result`/`auto_run_error`, dispatch handlers in
> `dispatch.rs`, and `project_links::get_by_service`. `auto_run_start` resolves
> the PlanFlow `external_id` server-side from `project_links` (service=planflow)
> — the client only sends `project_id`, so it can't assert an arbitrary PlanFlow
> identity. `stop` kills the live PTY + sets state=stopped (history kept).
> `auto_run_update` server-push NOT done yet — desktop polls `auto_run_status`.

Add to `protocol.rs` (`KNOWN_CLIENT_TYPES`) + `dispatch.rs` whitelist +
handlers:

- `auto_run_start { project_id, external_id, target_count, mode, start_at, pacing_minutes, deadline_at, on_failure }` → seed row, return queue.
- `auto_run_get { project_id }` / `auto_run_list` → current state.
- `auto_run_pause / _resume / _stop / _dismiss { project_id }`.
- `auto_run_event` server-push (mirror the `forward_stats` broadcaster in
  `dispatch.rs`) so the bar updates live without polling.

### Phase C — desktop becomes a thin client in cloud mode

> **Status: Phase C DONE** (typecheck clean except 2 pre-existing AppRoot.tsx
> errors unrelated to this work; lint clean; 53 vitest tests pass). Added
> `autoRunStart/Stop/Pause/Resume/Status` to `src/integrations/wsBridge/client.ts`
> (+ `auto_run_result`/`auto_run_error` to the inbound union) and a cloud/local
> split in `src/stores/autoRunQueue.ts`: an `origin: "local"|"cloud"` tag on the
> in-memory queue guards `tick`/`advance`/`pickAndDispatch` so the local loop
> never drives a cloud queue (and vice-versa across a mode toggle). Cloud mode
> routes start/pause/resume/stop through the WS bridge and polls `auto_run_status`
> (20s) to render `AutoRunBar`; local mode is byte-for-byte unchanged. The
> `origin` field is stripped before persisting to `app_settings` so the schema is
> unchanged. `AutoRunBar`/`AutoRunDialog` only gained `void`/async-chain tweaks
> because `startAutoRun`/pause/resume/stop are now async.
> Remaining: `auto_run_update` server-push (replace polling) + Phase D/F (GitHub
> verify, CLI detection).

- Split `autoRunQueue.ts`: **local mode** keeps the in-renderer tick loop;
  **cloud mode** routes every action through `auto_run_*` frames and renders
  agent-pushed state. The `cloudMode()` signal already exists
  (`src/ipc/transport.ts:31`).
- Queue persistence: in cloud mode the source of truth is the agent DB, not
  local `app_settings`. The store subscribes to `auto_run_event`.
- `AutoRunBar` / `AutoRunDialog` are unchanged in shape — they read the same
  `AutoRunQueue` projection regardless of where the loop runs.

### Phase D — server-side PR-merge verification

> **Status: Phase D DONE** (cloud-agent + core build, clippy-clean, 219
> cloud-agent + 137 core tests pass). New `src/github.rs`: per-project GitHub
> token store (`github_tokens/<project_id>`, 0600, path-jailed) + `github_token_set`
> WS frame; `parse_origin_repo` (SSH+HTTPS github.com) + `resolve_repo_for_project`
> (reads `<project.path>/.git/config` on the VPS, cached); a reqwest GitHub client
> `pr_is_merged` (GET `/repos/{o}/{r}/pulls?state=all&head={o}:{branch}`, optional
> Bearer, `GITHUB_API_BASE_URL` override for tests). `orchestrator.rs`
> `poll_merge_status` replaces the Phase A stub — ports `pollMergeStatus` exactly:
> no-branch / 60-min timeout / no-repo / token-load-error / any-API-error →
> advance (best-effort, never pins the queue); PR `merged_at != null` → advance;
> open PR → re-poll next tick. `GithubState` threaded through `spawn_orchestrator`.
> Token works unauthenticated for public repos. Remaining: surface
> `github_token_set` in the desktop UI; Phase F (CLI detection); auto_run_update push.

- New per-project **GitHub token store** on the agent, mirroring
  `planflow_tokens/<project_id>` (see `crates/cloud-agent/src/planflow_proxy.rs`).
- Resolve `owner/repo` from the cloud project's `.git/config` **on the VPS**
  (port `parseOriginRepo`, `autoRunQueue.ts:575`) and query the PR `merged_at`.
- Same 60-min timeout / best-effort skip semantics
  (`AUTO_RUN_VERIFY_MERGE_TIMEOUT_MS`).

### Phase E — reap + RAM guard (closes the orphan leak)

- PTY reap now runs agent-side in `completeCurrent` / `finishVerifyAdvance`
  regardless of desktop connection → no more orphan pile-up.
- Add a hard cap on concurrent auto-run PTYs per agent as a backstop.

---

## 4. Decisions needed before coding

1. **Prompt-construction duplication (TS ↔ Rust).** Port the small set
   (`formatPlanFlowStartPromptForMode`, idle-write timing) to Rust, or extract a
   shared spec? Recommendation: port — the surface is tiny and rarely changes.
2. **GitHub token on the agent.** New keychain dir + a `github_token_set` frame,
   parallel to `planflow_token_set`. Confirm the desktop should push it during
   the PlanFlow link flow.
3. **Multi-user / ownership.** Scope each queue to the project-link owner's
   token so a shared agent can't cross-dispatch. Single-user today, but bake it
   in now.
4. **Desktop ↔ agent dual-dispatch guard.** Once orchestration is agent-side,
   the desktop must NOT dispatch in cloud mode (only display). Enforce in the
   Phase C split.

---

### Phase F — CLI detection on the VPS (new blocker found in audit)

- Today `cli_list_available` (`src/ipc/cli.ts:20`) is a bare `invoke`, **not
  routed**, and there is **no agent frame** for it (`dispatch.rs:347`). So the
  desktop answers "does `claude` exist?" from the **local Mac PATH**, then sends
  the bare name in cloud mode (`AppRoot.tsx:1159`). A closed app = no detection;
  a Mac without `claude` = dispatch fails even though the VPS has it.
- Add a `cli_list_available` agent frame so detection runs on the VPS, and have
  the orchestrator resolve the CLI server-side.

### Phase G — server-side prompt injection (new blocker found in audit)

- `writePromptWhenReady` (`AppRoot.tsx:1341`) injects the `planflow_task_start(...)`
  prompt via a renderer `window.setTimeout` + `ptySubscribe` idle loop. The PTY
  lives on the VPS but the **prompt that drives it is written by the desktop** —
  close the app between spawn and idle-flush and the CLI sits **promptless
  forever**. Port the idle-detect + write into the orchestrator.

---

## 6. VPS environment findings (audit 2026-05-25, root@116.203.92.40)

Things that affect whether the agent can actually run a task autonomously:

- ✅ **`claude` CLI installed + authenticated** on the VPS — `/usr/bin/claude`
  v2.1.143, `~/.claude/.credentials.json` present (wsagent). Dispatch _can_ run
  server-side. Auth refreshed May 25, so it's live.
- ✅ Service runs as **`wsagent`**, config `/etc/cloud-agent/config.toml`,
  binary `/opt/cloud-agent/cloud-agent`. DB `/var/lib/cloud-agent/cloud-agent.db`
  (updated today → agent is in active use).
- ⚠️ **`planflow-mcp` not on the login PATH** (`command not found` for
  `wsagent -lc`), yet it was observed running earlier as
  `node ~/.npm-global/bin/planflow-mcp`. So claude's MCP config must reference an
  absolute path. Risk: if the orchestrator spawns `claude` with a minimal env,
  the MCP server may not resolve — **verify the spawn env includes
  `~/.npm-global/bin` on PATH**.
- ⚠️ **`cloudflared` systemd unit is `inactive`** — but the desktop clearly
  reaches the agent (DB updated today). Confirm how the tunnel is actually
  served (different unit, run by wsagent, or direct WS) before relying on it for
  an always-on agent.
- ⚠️ **No `sqlite3` binary** on the VPS — ops inspection/migration of the agent
  DB needs another tool; the agent's own `sqlx` migrations are unaffected.
- ⚠️ **No GitHub capability on the agent** (no GitHub frames, no token store) —
  blocks Phase D auto-merge verification (see §3 Phase D).
- ℹ️ Deployed agent binary dates **May 16**, behind current repo HEAD — any
  orchestration change requires a rebuild + redeploy to the VPS.

## 7. Immediate (independent of the migration)

- No cleanup needed right now: the orphan claude/planflow-mcp processes from the
  prior run already drained on their own (RAM back to ~591M used, 0 orphans as
  of 2026-05-25 09:57). The orphan-pile-up only recurs during an active queue
  with the app closed — Phase E fixes it permanently.
