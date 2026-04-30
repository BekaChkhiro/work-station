# Work Station

> Cross-platform desktop hub for managing multiple Claude Code / Kimi / Codex terminal sessions across projects. Built for raw performance and daily-driver comfort.

## Stack

- **Shell:** Tauri 2.0 (Rust core + native WebView)
- **Frontend:** Solid.js + TypeScript + Vite + Tailwind CSS
- **Terminal:** xterm.js 5 + WebGL renderer addon
- **PTY:** `portable-pty` crate (Rust, ConPTY on Windows / forkpty on macOS)
- **Async runtime:** tokio
- **Storage:** SQLite via `tauri-plugin-sql`

## Targets

- macOS 12+ (Apple Silicon + Intel universal binary)
- Windows 10 1809+ / Windows 11 (x64 + ARM64)
- Cold start: < 500ms
- RAM with 10 active terminals: < 300MB
- 60fps terminal rendering under heavy output

## Development

```bash
# Install dependencies
pnpm install

# Run in dev mode
pnpm tauri dev
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for full setup instructions, platform dependencies, and development workflow.

## Status

🚧 Early development — see [PROJECT_PLAN.md](./PROJECT_PLAN.md) for the roadmap.

## License

[MIT](./LICENSE)
