# PlanFlow cloud Start-task runbook (T19.36)

End-to-end smoke for the PlanFlow cloud integration chain (T19.32 → T19.35). A fresh contributor should be able to follow this on a clean VPS and finish with a green **Start** on a PlanFlow task that lives entirely on the cloud-agent.

This is **not** a substitute for `qa/cloud-mode-e2e.md` scenario 6 (which already covers PlanFlow tasks in cloud mode end-to-end). This runbook is narrower: it walks the **provisioning path** that scenario 6 assumes is already set up — agent paired, project pushed, PlanFlow linked, per-project token in place — and verifies each link in that chain produces the expected artifact before moving on.

## What this exercises

| Step                    | Task        | Verifies                                                                |
| ----------------------- | ----------- | ----------------------------------------------------------------------- |
| Pair agent              | T19.22 / 15 | Pairing token round-trip via Settings → Cloud                           |
| Push project to cloud   | T19.31      | Project row + (optional) rsync to the VPS                               |
| Link PlanFlow workspace | T19.32 / 33 | `project_link_set` round-trips through cloud transport                  |
| Drop per-project token  | T19.34      | `planflow_tokens/<project_id>` keychain file on the VPS                 |
| Start a task            | T19.35      | `cloud_project_id` ships on the WS frame; per-project token resolves    |
| PTY + lock              | T19.26 / 13 | Cloud PTY spawns in the linked project; `lockedBy.id === me` round-trip |

If any step fails, the rest are blocked — fix that step first and rerun from the top.

## Prerequisites

- A VPS provisioned per `docs/cloud-agent-vps.md` §1–§7 (cloud-agent running behind a Cloudflare Tunnel).
- A fresh Work Station dev build of the branch under test:
  ```bash
  pnpm install
  pnpm tauri dev
  ```
- A PlanFlow account with at least one workspace and one TODO task. You'll need:
  - The workspace UUID (`Settings → Workspace → ID` in PlanFlow, or grab it from the URL).
  - A PlanFlow API bearer token (`Settings → API tokens → New`). Keep it in your clipboard.
- The Work Station project you'll push **must not yet exist** on the cloud-agent (delete it first via SSH if a previous run left one).

Record the commit SHA (`git rev-parse --short HEAD`) at the top of the run notes — every step below is a regression suspect when this is changed.

## Step 1 — Pair the agent

1. On the VPS, run `sudo -u wsagent /opt/cloud-agent/cloud-agent pair show`. Copy the **URL + token** block it prints.
2. In the desktop app, open **Settings → Cloud → Pair**. Paste the block. Click **Pair**.
3. Wait for "Paired — last handshake at HH:MM:SS". The Workspace toggle dot in the header turns green.
4. Click **Cloud** in the Workspace toggle. The sidebar reloads to the (empty) cloud project list.

**Pass criteria:** dot is green, sidebar shows zero projects, no banner.

**Fail modes:**

- Dot stays amber → handshake succeeded but `lastHandshakeAt` wasn't stamped (T19.7 regression). Check `cloud_agent_status.needsRepairAt`.
- Token paste shows "Invalid token shape" → the agent re-keyed since `pair show`; re-run on the VPS.

## Step 2 — Push the project to cloud

1. Flip back to **Local** mode.
2. In the local sidebar, right-click a project that has at least one file you'll recognize (a `README.md` is enough). Pick **Push to cloud**.
3. Confirm the dialog. The push (T19.31) creates the project row on the agent and rsyncs the working tree to `/home/wsagent/code/<slug>/`.
4. Flip to **Cloud** mode. The pushed project is in the sidebar.
5. Click it. The active pane lands at the project's path **on the VPS** — confirm with `hostname && pwd`:
   ```
   ws-cloud-agent-dev
   /home/wsagent/code/<slug>
   ```

**Pass criteria:** the project appears in Cloud's sidebar, the pane is on the VPS, file tree shows the rsync'd files.

**Fail modes:**

- Push hangs at "Syncing files" → rsync over SSH is failing; check `~/.ssh/config` on the laptop and `wsagent`'s `authorized_keys`.
- Project row appears but `ls` on the VPS is empty → rsync silently no-op'd; rerun with `RSYNC_VERBOSE=1` in env.

Record the Work Station `project_id` for the cloud row (sidebar → right-click → **Copy project ID**, or `sqlite3` on the agent). You'll need it in Step 4.

## Step 3 — Link PlanFlow workspace (`project_link_set`)

This is the first half of T19.32 / T19.33 — wiring the project row to a PlanFlow workspace. In **Cloud** mode with the pushed project active:

1. Open **Settings → Integrations → PlanFlow**.
2. Paste the **workspace UUID** into the **Workspace ID** field.
3. Click **Link**. The renderer fires `project_link_set` (T19.32) over WS.
4. On the VPS, confirm the row landed in the cloud-agent's SQLite:
   ```bash
   sudo -u wsagent sqlite3 /var/lib/cloud-agent/db.sqlite3 \
     "SELECT project_id, service, external_id FROM project_links WHERE service='planflow';"
   ```
   Expect one row with `service=planflow` and your workspace UUID.

**Pass criteria:** the link row is in the agent's DB, **not** the local desktop's. Flipping to Local and checking `Settings → Integrations → PlanFlow` for the cloud project shows it unlinked there (different DB).

**Fail modes:**

- Link button errors with `invalid_args` → the workspace UUID didn't pass server-side shape validation; double-check you pasted the workspace ID, not a task ID.
- Row landed in the **local** desktop SQLite instead → T19.33 regression; `routeIpc` is still hitting `routeIpcLocalOnly`.

## Step 4 — Drop the per-project PlanFlow token (`planflow_token_set`)

The Integrations UI that bundles this into the Link flow is still pending wiring — until it lands, drop the token via SSH. The acceptance test is the same either way: the keychain file must exist with mode 0600 owned by `wsagent`.

On the VPS, with `<PROJECT_ID>` set to the Work Station project_id from Step 2 and `<TOKEN>` set to the PlanFlow bearer:

```bash
sudo -u wsagent install -m 0600 /dev/stdin \
  /var/lib/cloud-agent/planflow_tokens/<PROJECT_ID> <<<"<TOKEN>"
sudo -u wsagent ls -l /var/lib/cloud-agent/planflow_tokens/<PROJECT_ID>
# expect: -rw------- 1 wsagent wsagent ... <PROJECT_ID>
```

> **Sanity check — `cloud_project_id` is the Work Station `projects.id`, not the PlanFlow workspace UUID from Step 3.** A token filed under the wrong ID is invisible to the proxy and the request falls through to the daemon-wide token (or fails outright if none is set).

**Pass criteria:** the file exists, mode is `0600`, owner is `wsagent`, content is the trimmed bearer.

**Fail modes:**

- `Permission denied` writing the file → you're not `wsagent`; rerun under `sudo -u wsagent`.
- File exists but `planflow_` calls in Step 5 fail with `credential` → most likely the project id has a character outside the proxy's allow-list (alphanumeric, hyphen, underscore — everything else is rejected). Inspect `journalctl -u cloud-agent -n 50 | grep planflow` for the exact reason.

(When the UI lands, this step collapses to "paste the token into Settings → Integrations → PlanFlow → API token, click Save"; the runbook will switch to that path.)

## Step 5 — Start a PlanFlow task

In **Cloud** mode with the project active:

1. Open the **Tasks** tab in the project workspace.
2. The list populates with your PlanFlow workspace's tasks — proof that the proxy resolved the **per-project** token (Step 4), not the daemon-wide one.
3. Pick a TODO task. Click **Start**.
4. The task flips to IN_PROGRESS. The desktop:
   - Spawns a cloud PTY in the project (T19.26).
   - Runs the task's CLI in that PTY.
   - Stamps `lockedBy.id === me` on the task.

5. Refresh the Tasks tab. The IN_PROGRESS state and lock survive — they're in the agent's PlanFlow data, not in-memory.

**Pass criteria:**

- The PTY's prompt is on the VPS (`hostname` confirms).
- The task row shows the lock badge with **your** user name (not "someone else").
- `journalctl -u cloud-agent -n 20 | grep planflow` shows the request resolved the keychain token (the proxy logs the resolution step at `debug`).

**Fail modes:**

- Tasks tab shows the **wrong** workspace's tasks → the agent is using the daemon-wide token. Check Step 4's file path (most often a `cloud_project_id` mismatch).
- Tasks tab empty / 401 → the token in Step 4 is invalid or expired. Rotate it in PlanFlow, redo Step 4.
- Start spawns a **local** PTY → T19.35 regression; the renderer didn't ship `cloud_project_id` on the WS frame.
- Start succeeds but `lockedBy` is empty / wrong user → `getMe` resolved a different account's token (a Step 4 mismatch on another project on the same agent), or the renderer is still routing `getMe` unscoped.

## Step 6 — Cleanup

1. Click **Done** on the task with a one-line summary. The task flips to DONE; the lock clears; the cloud PTY exits.
2. (Optional) In **Settings → Integrations → PlanFlow**, click **Unlink**. The `project_link_delete` frame removes the row from the agent's SQLite.
3. (Optional) On the VPS, remove the keychain file:
   ```bash
   sudo -u wsagent rm /var/lib/cloud-agent/planflow_tokens/<PROJECT_ID>
   ```
   Subsequent `planflow_*` calls for this project will fall back to the daemon-wide token (or fail if none is configured).

## Matrix

One row per (OS × run). Columns mirror `qa/cloud-mode-e2e.md`.

| OS      | Date | App SHA | Agent SHA | Build | Result | Notes |
| ------- | ---- | ------- | --------- | ----- | ------ | ----- |
| macOS   |      |         |           |       |        |       |
| Windows |      |         |           |       |        |       |

## When to re-run

- After any change in `crates/cloud-agent/src/planflow_proxy.rs` (resolver order, path-jail, token store).
- After any change in `src/integrations/planflow/client.ts` or `clientFactory.ts` (`cloud_project_id` plumbing).
- After bumping the WS protocol (`crates/workstation-core/src/ws/protocol.rs`) on a frame in `KNOWN_CLIENT_TYPES` that's touched by this flow.
- Before tagging a release that includes any of the above.

## Out of scope (deferred)

- An **Integrations panel UI** that wraps Step 4 (`planflow_token_set` from the renderer). Until it lands, Step 4 is the SSH path documented here.
- Automated CI coverage of the full chain — needs a CI VPS and credential management; same blocker as `cloud-mode-e2e.md`.
- Multi-token rotation under load — the proxy reloads the token on each request, so rotation is a no-op replay of Step 4. Add an explicit scenario if a flake surfaces.
