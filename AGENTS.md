# AGENTS.md — Contract for AI-Assisted Contributors

This file is the working contract for AI coding assistants (Claude Code, Cursor, Copilot, etc.) operating in this repository. Humans should read it too — it captures the conventions that protect the project from drift.

> **Scope:** Work Station is a **personal-use** Tauri 2.x desktop app for one developer. Privacy and pinning are intentional; many "best-practice" public-OSS patterns do not apply here. When in doubt, defer to `PROJECT_PLAN.md`. When the plan and this file disagree, **the plan wins** — propose an edit via PR.

---

## 1. Source-of-truth hierarchy

When sources conflict, resolve in this order:

1. **`PROJECT_PLAN.md`** — locked decisions, phase tasks, acceptance criteria. Always re-read the relevant phase before editing.
2. **`work-station-design/`** — canonical visual + interaction reference (interactive React prototype). For UX details, the prototype wins over prose.
3. **`DESIGN_PROMPT.md` + `DESIGN_PROMPT_PHASE2.md`** — design briefs that produced the prototype.
4. **`README.md` / `CONTRIBUTING.md`** — onboarding + quickstart.
5. **This file (`AGENTS.md`)** — workflow rules for AI-assisted edits.

Never invent a fact about the project. If `PROJECT_PLAN.md` doesn't answer a question, ask the user before encoding an assumption in code.

---

## 2. Workflow — PlanFlow MCP first

This repo is indexed by [planflow-mcp](https://www.npmjs.com/package/planflow-mcp). PlanFlow tools are the **first move** for any non-trivial change.

| Situation                                 | First call                                  |
| ----------------------------------------- | ------------------------------------------- |
| User names a task ID (`T2.4`, `T6.5`, …)  | `planflow_task_start(taskId: "...")`        |
| User describes a change without a task ID | `planflow_explore(intent: "<the request>")` |
| You have a sharp keyword                  | `planflow_search(query: "...")`             |
| You need to read a returned chunk in full | `planflow_chunk(chunkId: "...")`            |

Direct `grep` / `Read` is the **fallback**, not the first move. After non-trivial edits, run `planflow_index` (or `planflow-mcp index` from the CLI) so the next session sees fresh context.

Save architectural decisions, conventions, or non-obvious tradeoffs with `planflow_remember(...)`. Don't journal routine progress as knowledge — use `planflow_task_progress` for that.

---

## 3. Hard rules — do not violate without explicit user approval

These are locked decisions from `PROJECT_PLAN.md` §8 and the stack table. Touching them silently has caused regressions before — always confirm first.

1. **Pinned versions are pinned.** `@tauri-apps/*`, `solid-js`, and the `tauri` / `tauri-build` Rust crates use **exact** versions (no `^`, no `~`). Bumps go through a manual PR with cross-platform build verification (T1.6). Do not "modernize" lockfiles.
2. **No telemetry. No crash reporter. No auto-updater.** This is single-user. Don't add Sentry, PostHog, Amplitude, electron-updater equivalents, or any "anonymous usage stats." The Settings → Privacy section in the prototype renders disabled toggles for design coherence only.
3. **macOS + Windows only.** Linux is deferred to Phase 11 (stretch). Don't add Linux-specific code paths or CI matrices unless explicitly asked.
4. **Unsigned builds are intentional.** Don't add Apple notarization, Authenticode signing, codesign hooks, or DeveloperId logic.
5. **Local PTYs only.** No SSH client, no remote terminal, no WebSocket-based shell forwarding.
6. **Session restore model, not daemon survival.** PTYs do not survive full app quit in v0.1 (`PROJECT_PLAN.md` §3). Don't sketch a long-running daemon.
7. **No new dependencies without justification.** Prefer the standard library or an existing dep. If you must add one, name it in the PR description with the alternative you considered.
8. **Don't bypass the git hooks** (`--no-verify`) unless the user explicitly says so. If the hook fails, fix the underlying issue.

---

## 4. Quality gates — must be green before "done"

Run these before declaring a task complete. CI runs the same set (T9.1).

| Gate                              | Command                                                                     |
| --------------------------------- | --------------------------------------------------------------------------- |
| TypeScript strict                 | `pnpm typecheck`                                                            |
| ESLint (typescript-eslint strict) | `pnpm lint`                                                                 |
| Prettier                          | `pnpm format:check`                                                         |
| Rust format                       | `cd src-tauri && cargo fmt --check`                                         |
| Rust lints                        | `cd src-tauri && cargo clippy --all-targets -- -D warnings`                 |
| Build (smoke)                     | `pnpm tauri build` (only when the task touches build config or native code) |

TypeScript runs with `strict: true`, `noImplicitAny`, and `noUncheckedIndexedAccess`. Don't bypass with `// @ts-expect-error` or `as unknown as` casts unless the alternative is genuinely worse — and leave a one-line comment explaining why.

---

## 5. Coding conventions

### Frontend (Solid.js + TypeScript)

- Solid is **not React**. Use `createSignal` / `createMemo` / `createEffect`, not hooks. Components run **once**; reactivity comes from accessor calls inside JSX. Don't destructure props at the top of a component — that breaks reactivity. Use `props.x` directly.
- Tailwind utilities live in components; design tokens (colors, spacing, motion) are CSS variables defined in `src/styles/tokens.css`. Don't hardcode hex colors or pixel sizes — go through tokens.
- Respect `prefers-reduced-motion` at the token level; component code shouldn't conditionally branch on it.
- Use the **OKLCH** color space for tokens (per `PROJECT_PLAN.md` §1.5 and the prototype's `styles.css`). Don't translate to hex or HSL.
- IPC calls live in `src/ipc/`. Components call typed wrappers, not `invoke` directly. Wrappers throw typed errors (`PtyError`, `DbError`, …) that error boundaries catch.

### Backend (Rust + Tauri 2.x)

- Module layout under `src-tauri/src/`: `pty`, `db`, `commands`, `ipc`, `cli`, `menu`. Don't create a new top-level module without checking `PROJECT_PLAN.md`.
- All Tauri commands live in `commands/` and are wired in `lib.rs`. Commands are thin — business logic goes in `pty/`, `db/`, etc.
- Async runtime is **tokio**. Don't introduce `async-std` or block on the runtime from a sync context (`block_on` inside an async fn is a bug).
- Errors: each module owns a typed error enum (`thiserror`). Commands return `Result<T, AppError>` where `AppError` is a serde-serializable façade. Don't return `String` errors.
- Logging via `tracing`. No `println!` in production code. The crash-reporter slot is dropped (D6) — `tracing` log files are the diagnostic surface.

### Tests

- Frontend: Vitest in `*.test.ts(x)` co-located with the source. Don't mock Tauri's `invoke` — use the typed wrapper layer's seams.
- Rust: unit tests in `#[cfg(test)] mod tests` blocks; integration tests in `src-tauri/tests/`.
- **PTY tests must hit a real `portable-pty` PTY.** Mocking the PTY hides the platform-specific bugs (ConPTY vs. forkpty) that this project exists to handle.
- **DB tests must hit a real SQLite file** (use `tempfile`). Mock-DB tests have hidden migration regressions before — see `PROJECT_PLAN.md` Phase 3 history.

---

## 6. Editing rhythm

For each task:

1. **Discover** — `planflow_task_start` (named task) or `planflow_explore` (free-form), then read full chunks via `planflow_chunk`.
2. **Confirm scope** — restate the change in one sentence. If it grows beyond the task's acceptance criteria, stop and ask.
3. **Edit** — prefer `Edit` over `Write` for existing files. Don't rewrite a file to change three lines.
4. **Validate** — run the gates from §4. Type-checking and tests verify code correctness, **not feature correctness** — for UI changes, run `pnpm tauri dev` and exercise the feature in the live window before claiming success.
5. **Re-index** — `planflow-mcp index` (CLI) or `planflow_index` so the next session sees the change.
6. **Close** — `planflow_task_done(taskId, summary)` and let it suggest a Conventional Commits message.

---

## 7. Commits and PRs

- **Conventional Commits** are enforced by `.githooks/commit-msg`: `<type>(<scope>)?!?: <subject>` with subject ≤ 72 chars. Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
- **Do not add a `Co-Authored-By: Claude` trailer.** Commits are authored by the human contributor.
- **Branch protection on `master`:** PR + linear history. Branch name: `task/<id>-<slug>` (e.g. `task/T1.7-developer-documentation`).
- PRs reference the task ID in the title and link to the relevant `PROJECT_PLAN.md` section in the description. Acceptance criteria from the plan goes in the PR's "How verified" section, with the gate commands you ran.
- One PR per task. Don't bundle unrelated tasks. Don't ship "drive-by" refactors with feature work — open a separate `refactor:` PR.

---

## 8. Things AI assistants frequently get wrong here

Patterns that have caused churn before — call them out and stop:

- **Treating Solid like React.** No `useState`/`useEffect`, no top-of-component prop destructuring, no `key` props on lists (use `<For>` / `<Index>`).
- **Adding "graceful fallbacks" for impossible states.** This codebase trusts internal invariants. Validate at the IPC boundary and the SQLite boundary; everywhere else, let it crash and log.
- **Inventing telemetry/observability hooks.** No "just one analytics event for debugging." `tracing` log files are the only diagnostic surface.
- **Bumping pinned dependencies opportunistically** while doing unrelated work. If you notice a stale pin, mention it in the PR description and stop.
- **Hardcoding design values.** Always go through the token layer (CSS variables in `src/styles/tokens.css` and the matching prototype tokens).
- **Writing multi-paragraph code comments / docstrings.** One-line comments only, and only when the _why_ is non-obvious. Identifiers should explain _what_.
- **Mocking PTYs / SQLite in tests.** Don't. See §5 → Tests.
- **Adding Linux paths "while we're at it."** Phase 11. Not now.

---

## 9. Repository quick-reference

| Need                           | Where                                                |
| ------------------------------ | ---------------------------------------------------- |
| Local setup, platform deps     | `CONTRIBUTING.md`                                    |
| Plan of record                 | `PROJECT_PLAN.md`                                    |
| Locked decisions               | `PROJECT_PLAN.md` §8                                 |
| Visual + interaction reference | `work-station-design/` (interactive React prototype) |
| Task → prototype component map | `PROJECT_PLAN.md` §1.5                               |
| Stack rationale                | `PROJECT_PLAN.md` §1                                 |
| Risk register                  | `PROJECT_PLAN.md` §7                                 |
| PTY lifetime model             | `PROJECT_PLAN.md` §3                                 |
| ESLint config                  | `eslint.config.js`                                   |
| Prettier config                | `.prettierrc.json` + `.prettierignore`               |
| Git hooks                      | `.githooks/`                                         |

If a path or filename in this document doesn't match what you find, **trust the repo** — files move and AGENTS.md may have drifted. Open a PR to update this file when you spot the gap.
