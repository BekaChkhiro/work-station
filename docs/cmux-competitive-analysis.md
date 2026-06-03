# Work Station vs cmux — კონკურენტული ანალიზი და killer-feature სტრატეგია

> შედგენილია 2026-06-02. წყაროები: cmux GitHub repo, Product Hunt / vibecoding / soloterm review-ები,
> cmux GitHub issues (#153 და სხვ.). Work Station მხარე — `PROJECT_PLAN.md` + რეალური `src/`, `crates/cloud-agent/`, `mobile/`.

## 0. ერთ წინადადებაში

- **cmux** = საუკეთესო _ტერმინალი_ agent-ების გასაშვებად (native macOS, Ghostty, განზრახ "primitive", არა ორკესტრატორი).
- **Work Station** = _command center / autopilot_ agent-ების ფლოტისთვის — cross-platform, cloud, mobile, ავტონომიური orchestration.

ⓘ მთავარი დასკვნა: **ნუ ვცდილობთ cmux-ს ვაჯობოთ "უკეთესი macOS ტერმინლის" ღერძზე** — იქ ის native-ად სწრაფია და 7.7k ★ აქვს. ვიგებთ **სხვა კატეგორიაში**: ორკესტრაცია + ღრუბელი + mobile + cross-platform.

---

## 1. Feature-by-feature შედარება

ლეგენდა: ✅ აქვს/აშენებულია · 🟡 ნაწილობრივ/დაგეგმილი · ❌ არ აქვს

### A. ბირთვი — ტერმინალი

| ფიჩერი                       | cmux                          | Work Station                                         |
| ---------------------------- | ----------------------------- | ---------------------------------------------------- |
| Rendering                    | ✅ libghostty (GPU, native)   | ✅ xterm.js + WebGL                                  |
| Memory/latency               | ✅ Swift/AppKit — მსუბუქი     | 🟡 Tauri WebView — მძიმდება                          |
| Splits / tabs                | ✅ vertical + horizontal      | ✅ recursive layout tree (`LayoutTree`, `SplitPane`) |
| Scrollback restore           | ✅                            | ✅ persistent + replay on mount                      |
| In-terminal search           | ✅                            | ✅ + **cross-session search** (`CrossSessionSearch`) |
| Ghostty config compat        | ✅                            | ❌ (საკუთარი theme system)                           |
| Clickable links / copy-paste | ✅                            | ✅                                                   |
| **შეფასება**                 | **cmux წინ — native სიჩქარე** | parity ფუნქციაზე, ჩამორჩება perf-ზე                  |

### B. agent-aware UX

| ფიჩერი                                | cmux                                                      | Work Station                       |
| ------------------------------------- | --------------------------------------------------------- | ---------------------------------- |
| Notification rings (green/yellow/red) | ✅ მომწიფებული                                            | 🟡 `NotificationsBell` — საბაზისო  |
| OSC 9/99/777 sequences                | ✅                                                        | 🟡                                 |
| CLI hook (`cmux notify`)              | ✅                                                        | ❌                                 |
| **Notification-ის შინაარსი**          | ❌ generic "Claude is waiting for input" (ცნობილი ჩივილი) | 🟡 **შესაძლებლობა გვაქვს ვაჯობოთ** |
| Per-tab git branch / PR / port badge  | ✅ sidebar metadata                                       | 🟡 CLI badge on tabs               |

### C. ორკესტრაცია (აქ ვიწყებთ მოგებას)

| ფიჩერი                              | cmux                            | Work Station                                                             |
| ----------------------------------- | ------------------------------- | ------------------------------------------------------------------------ |
| ფილოსოფია                           | ❌ **განზრახ არა-ორკესტრატორი** | ✅ ორკესტრატორი                                                          |
| Auto-run task queue                 | ❌                              | ✅ `autoRunQueue` + cloud-agent `auto_run/`                              |
| ავტონომიური დისპეჩი (აპი დახურულზე) | ❌                              | ✅ server-side loop VPS-ზე                                               |
| PR-merge verification               | ❌                              | ✅ `verifiers/` + `github.rs`                                            |
| Task management                     | ❌                              | ✅ **PlanFlow** ღრმად ინტეგრირებული (`PlanFlowTaskList`, `PlanFlowChat`) |

### D. Cloud / Remote

| ფიჩერი                       | cmux                                   | Work Station                                |
| ---------------------------- | -------------------------------------- | ------------------------------------------- |
| SSH remote workspace         | ✅ `cmux ssh`                          | 🟡 (cloud-agent ცვლის ამ მოდელს)            |
| რეალური cloud daemon (VPS)   | ❌ Founder's Edition early-access only | ✅ `crates/cloud-agent` + Cloudflare Tunnel |
| Detach / reattach            | ❌ (ცნობილი ჩივილი — tmux-ს ვერ ცვლის) | ✅ desktop attach/detach WS-ით              |
| **Mobile / tablet კონტროლი** | ❌ (iOS — early-access only)           | ✅ **`mobile/` PWA companion**              |

### E. გარემოს ინტეგრაციები

| ფიჩერი                             | cmux                           | Work Station                                            |
| ---------------------------------- | ------------------------------ | ------------------------------------------------------- |
| Built-in browser (scriptable)      | ✅ snapshot/click/fill/JS eval | ❌                                                      |
| Browser import (20+ browsers)      | ✅                             | ❌                                                      |
| Code editor                        | ❌                             | ✅ **Monaco** + file tree (`MonacoEditor`, `FileTree`)  |
| GitHub dashboard (PR/Actions)      | ❌ (browser-ში გადი)           | ✅ `integrations/github`                                |
| Vercel / Neon / Railway dashboards | ❌                             | 🟡 დაგეგმილი (Phase 15–17, ჯერ მხოლოდ github აშენებული) |
| Encrypted credential store         | ❌                             | ✅ `credentials/` (OS keychain)                         |

### F. პლატფორმა / ლიცენზია / community

|           | cmux                             | Work Station               |
| --------- | -------------------------------- | -------------------------- |
| OS        | ❌ **მხოლოდ macOS**              | ✅ macOS + Windows (Tauri) |
| ლიცენზია  | ✅ open-source (GPL/AGPL), უფასო | ❌ private, single-user    |
| Community | ✅ 7.7k ★ პირველ თვეში           | ❌ ჯერ არა                 |
| სიმწიფე   | 🟡 ახალი (Feb 2026), rough edges | 🟡 v0.1 in progress        |

---

## 2. სად გვჯობს cmux (პატიოსნად)

1. **Native perf / low memory** — Swift/AppKit vs Tauri WebView. ამას ვერ მოვიგებთ; ავირიდოთ პირდაპირი ბრძოლა.
2. **Scriptable built-in browser + browser import** — მძლავრი, ჩვენ არ გვაქვს.
3. **მომწიფებული notification სისტემა** — rings + OSC + CLI hook.
4. **Open-source momentum** — უფასო, 7.7k ★, commercial license org-ებისთვის.
5. **Ghostty config compatibility** — power-user-ებს მზა კონფიგი გადააქვთ.

## 3. სად უკვე ვჯობთ cmux-ს

1. **Cross-platform** — Windows დეველოპერების მთელი ბაზარი cmux-ს გამორჩა.
2. **რეალური ორკესტრაცია** — auto-run queue + PR-merge verify. cmux _პრინციპით_ არ აკეთებს ამას.
3. **რეალური cloud daemon + mobile** — cmux-ის cloud/iOS მხოლოდ early-access.
4. **ჩაშენებული Monaco editor** — agent-ის ცვლილებას ადგილზევე ასწორებ.
5. **PlanFlow task management** — გეგმა → agent task-ების რიგი.
6. **In-app dashboards** (GitHub უკვე, Vercel/Neon/Railway გზაში) — CI/deploy შესამოწმებლად browser-ში არ გადიხარ.

---

## 4. KILLER FEATURES — პრიორიტეტული roadmap

თითოეული პირდაპირ პასუხობს cmux-ის რეალურ ჩივილს ან ხარვეზს.

### 🥇 Tier 1 — moat (აქ ვერავინ გვედრება)

**K1. Mobile mission control (agent-ები ჯიბიდან).**
cmux-ის iOS early-access-ია; ჩვენ უკვე გვაქვს `mobile/` PWA + cloud-agent.

- Push notification როცა agent კითხვას სვამს → ტელეფონიდან **Approve/Reject/answer**.
- Live progress, diff preview, queue management ტელეფონიდან.
- _Pitch: "დაიწყე 5 agent, დახურე ლეპტოპი, აკონტროლე ჯიბიდან."_ — cmux-ს ეს **არ შეუძლია**.

**K2. ავტონომიური orchestration + worktree-per-agent fan-out.**
cmux _პრინციპით_ primitive-ია. ჩვენი queue უკვე არსებობს — გავაძლიეროთ:

- თითო task → ცალკე **git worktree** (+ optional sandbox: macOS seatbelt / Docker), პარალელური agent-ები კონფლიქტის გარეშე.
- avტო-merge მწვანე CI + PR-verify-ზე (ბირთვი უკვე გვაქვს: `verifiers/`, `auto_run/`).
- _Pitch: "ერთი plan → 10 agent პარალელურად, თითო იზოლირებულ worktree-ში, ავტო-merge."_
- აქვე ვფარავთ cmux-ის **sandboxing არ-არსებობას**.

**K3. Context-rich notifications (cmux-ის #1 ჩივილის პირდაპირი მოკვლა).**
cmux: notification body ყოველთვის "Claude is waiting for your input" — უაზრო.
ჩვენ ვაპარსოთ agent output და ვაჩვენოთ:

- _რომელი_ კითხვაა (yes/no, ფაილის წაშლა, ბრძანების approval).
- რომელ task/branch/ფაილზე, mini-diff summary.
- one-tap actions notification-შივე (desktop + mobile).

### 🥈 Tier 2 — ფართო გამარჯვება

**K4. Cross-platform first-class (Windows).** cmux-ს ეს ბაზარი არ ეხება — ConPTY უკვე გვაქვს. დავხვეწოთ Windows UX.

**K5. Unified dev-ops dashboard.** Vercel/Neon/Railway (Phase 15–17) + GitHub Actions ერთ პანელში — agent push-ავს, შენ deploy/CI/DB ხედავ აპიდანვე გაუსვლელად. cmux browser-ში გაგდებს.

**K6. Cost & usage tracking.** token/$ spend თითო agent/task-ზე, ჯამური burn-rate, budget cap (auto-stop). ამას ფაქტობრივად **არავინ** აკეთებს კარგად — agent fleet-ისთვის ეს მკვლელია.

**K7. Multiplayer / team cloud workspace.** cmux-ს multiplayer **არ აქვს**. shared cloud-agent workspace, სადაც გუნდი ერთ agent fleet-ს უყურებს/ერთვება. (Claude Code Teams-ის cmux-ვერსიას ნამდვილ remote-collab-ით ვცვლით.)

### 🥉 Tier 3 — paritet / polish

**K8. Scriptable CLI/socket API** — cmux-ის tmux-parity ჩივილებზე პასუხი (capture-pane, pipe-pane, wait-for ანალოგები). hooks-ისთვის აუცილებელი.
**K9. Session restore polish** — layout/scrollback/editor state სრული აღდგენა (cmux-ის "no session restore on relaunch" ჩივილი).
**K10. Notification CLI hook** (`workstation notify`) — agent-ებში მარტივი wiring, OSC 9/99/777 სრული მხარდაჭერა.

---

## 5. პოზიციონირება (როგორ გავყიდოთ)

> **cmux** გაძლევს საუკეთესო ფანჯარას agent-ის სანახავად.
> **Work Station** აგენტებს _თვითონ ამუშავებს, ამოწმებს და merge-ავს_ — ნებისმიერი OS-დან, ლეპტოპიდანაც და ტელეფონიდანაც.

თუ ვინმეს cmux-ში აკლია: ① Windows, ② "agent-ები თვითონ ირბენდნენ დახურულ აპზე", ③ ტელეფონიდან კონტროლი, ④ აზრიანი notification-ები, ⑤ ჩაშენებული editor/DB/deploy dashboard — **ეს ყველაფერი ჩვენი ტერიტორიაა.**

ერთადერთი, რასაც _არ_ უნდა დავედევნოთ: native macOS terminal perf. იქ ვუთმობთ და სხვა ღერძზე ვიგებთ.

---

## 6. Killer features senior / power დეველოპერებისთვის

> 2026-ის სიგნალი (ODSC / hitechies / developersdigest): seniors **სკეპტიკურები** არიან "autopilot magic"-ზე.
> აფასებენ: **control, transparency (provenance + tool-call traces), local-first / no-telemetry,
> scriptability, usage economics, architectural-drift oversight.** cmux power-user-ები ცალკე უჩივიან
> tmux-scriptability-ს (#153) და Ghostty-config მოლოდინს.
>
> **მთავარი reframe:** ჩვენი ორკესტრაცია seniors-ს უნდა მივყიდოთ არა როგორც "ავტომატიკა",
> არამედ როგორც **კონტროლირებადი, აუდიტირებადი, scriptable control plane.** იგივე moat — სხვა ენით.

### 🔬 S1. Agent audit trail / provenance timeline — _#1 senior მოთხოვნა_

ყველა tool-call, ფაილ-write, ბრძანება, model-decision — timestamp-ით, replayable timeline-ად.

- "ვინ/რა agent-მა, რომელ task-ში, რა ბრძანება გაუშვა და რატომ" — სრული git-მსგავსი ჩანაწერი.
- export → JSONL; query SQLite-ით (ჩვენი მონაცემები ისედაც ლოკალურ SQLite-შია).
- _რატომ უყვართ:_ "provenance, tool-call traces, policy decisions like a first-class feature."

### 🔬 S2. Diff-first merge gate + programmable hooks

არაფერი merge-დება reviewable diff-ისა და gate-ების გავლის გარეშე.

- per-hunk approve; pre-task / post-diff / pre-merge **hooks** — შენი ლინტერი/ტესტი/policy script gate-ად.
- seniors-ს სძულთ blind auto-merge → ეს მათ კონტროლს უბრუნებს, ჩვენს ავტონომიას კი არ კლავს.

### 🔬 S3. Config-as-code (versionable workspace)

მთელი workspace — projects, layout, splits, per-agent env, startup, policy — **ერთ git-committable TOML/YAML-ში**.

- `.tmux.conf`-ის ფილოსოფია, რომელიც cmux-ის Ghostty-config მოყვარულებს პირდაპირ ხიბლავს.
- reproducible setup გუნდში; PR-ში ნახავ ვინ შეცვალა agent policy.

### 🔬 S4. Scriptable CLI + socket API + keyboard-everything

tmux-parity, რომელიც cmux-ს **აკლია** (issue #153): `capture-pane`, `pipe-pane`, `wait-for`, `send-keys` ანალოგები.

- ყველა მოქმედება headless — CI-დან, script-იდან, hook-იდან.
- command palette ნამდვილი command-ენით; vim-mode navigation. seniors keyboard-driven workflow-ს ითხოვენ.

### 🔬 S5. Policy / guardrails engine (programmable sandbox)

allow/deny ბრძანებები, destructive-op approval, per-project **sandbox policy** (worktree + seatbelt/cgroup/Docker).

- secrets (SSH/AWS keys) agent-ს მიუწვდომელი; network egress policy.
- security-minded seniors-ის უმთავრესი ნდობის სიგნალი; cmux-ს sandboxing **საერთოდ არ აქვს**.

### 🔬 S6. Usage economics — token/$ accounting + budgets

token/cost per task / agent / project, live burn-rate, **budget cap → auto-stop**.

- 2026-ში პირდაპირ დასახელებული მოთხოვნა ("usage economics"). ფაქტობრივად არავინ აკეთებს კარგად.

### 🔬 S7. No lock-in — BYO endpoint / local models

ნებისმიერი OpenAI-compatible endpoint / local Ollama routing. vendor lock-in seniors-ს სძულთ.

- - **local-first / zero telemetry** (README-ში უკვე გვაქვს) — data sovereignty-ად ხმამაღლა გავყიდოთ.

### 🔬 S8. Architectural drift / oversight panel

დროში თვალყური: კოდბეისის რა ნაწილია agent-authored, სად გროვდება tech-debt/drift.

- "cumulative architectural drift… senior-engineer work" — ჩვენ ეს გავხადოთ ხილული პანელი.

### 🔬 S9. Reproducible / replayable runs

task-run-ის deterministic replay, snapshot + re-dispatch იგივე input-ით. debugging + ნდობა.

### 🔬 S10. Live observability panel

per-agent CPU/RAM/token/latency (გვაქვს `system_stats` broadcaster) — metrics-პანელი, რომელსაც seniors აფასებენ.

---

**senior-სთვის ერთ წინადადებად:** _"ავტონომიური agent fleet, მაგრამ შენ ხელში — ყველა tool-call აუდიტში,
ყველა merge gate-ს უკან, config git-ში, policy შენი, ხარჯი ხილული, telemetry ნული."_
