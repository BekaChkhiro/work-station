# Configurable Shell Init (T4.14)

Per-project knobs that influence what the spawned shell sees: environment
variables, startup commands, and the user's normal rc files.

## What loads, when

Work Station spawns whichever command the project's `defaultCli` resolves
to (e.g. `zsh`, `bash`, `fish`, `pwsh`, `cmd`). The shell runs inside a
real PTY without `-c`, so it starts in **interactive** mode and reads its
normal user-level rc files:

| Shell     | Files loaded (interactive, non-login)                |
| --------- | ---------------------------------------------------- |
| `zsh`     | `~/.zshenv`, `~/.zshrc`                              |
| `bash`    | `~/.bashrc` (via `~/.bash_profile` if you source it) |
| `fish`    | `~/.config/fish/config.fish`                         |
| `pwsh`    | `$PROFILE` (`Microsoft.PowerShell_profile.ps1`)      |
| `cmd.exe` | None — use a startup command if you need init        |

If you want **login** behaviour (`~/.zprofile`, `~/.bash_profile`, etc.)
override the project's `defaultCli` to `zsh -l` or `bash -l`. The PTY
spawn API takes the literal command + args and passes them through; the
shell decides the rest based on its own conventions.

## Per-project environment variables

Set on the project (`projects.env_json`). Each key/value is layered on
top of `TERM=xterm-256color` and `COLORTERM=truecolor` (the PTY-friendly
defaults) and forwarded to the shell via `CommandBuilder::env`. The
shell sees them before any rc file runs, so `.zshrc` can branch on
`$NODE_ENV` or similar.

```jsonc
// project row
"env": { "NODE_ENV": "development", "DATABASE_URL": "postgres://localhost/dev" }
```

## Per-project startup commands

Set on the project (`projects.startup_commands_json`). Each entry is fed
to the shell's stdin as if you typed it — terminating `\n` is appended
on the Rust side, and the shell's parser/aliases apply normally. The
commands run **after** subscribers are attached, so their output lands
in the scrollback buffer and live subscriptions both.

```jsonc
"startupCommands": [
  "cd packages/api",
  "npm run dev"
]
```

Empty/whitespace-only entries are skipped server-side, so you can keep
configuration arrays without filtering. If a write fails (the shell
exited mid-startup, etc.) the remaining commands are skipped and a
`tracing::warn!` is logged; the session itself stays alive and the
subscriber sees whatever the shell wrote before the failure.

## Failure mode acceptance

- Project with `NODE_ENV=development` → `echo $NODE_ENV` prints
  `development` in a fresh pane.
- User's `~/.zshrc` aliases (e.g. `alias gs='git status'`) work in a
  fresh pane without further configuration.
