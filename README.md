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

## Releases & Auto-Updates

The app uses [Tauri's built-in updater](https://v2.tauri.app/plugin/updater/) with **GitHub Releases** as the update source.

- The updater checks `https://github.com/beqolozi/work-station/releases/latest/download/latest.json` on startup
- New releases are published automatically via GitHub Actions when a `v*` tag is pushed
- Binaries are signed with the Tauri updater private key (see `.tauri-updater.key`)

### Creating a release

```bash
# 1. Bump version (syncs package.json, Cargo.toml, tauri.conf.json)
node scripts/bump-version.js patch   # or minor / major

# 2. Commit and tag
git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json src-tauri/Cargo.lock
git commit -m "chore(release): bump version to x.y.z"
git tag vx.y.z
git push origin vx.y.z
```

Pushing the tag triggers the [Release workflow](.github/workflows/release.yml), which builds for macOS (arm64 + x64) and Windows (x64), signs the bundles, and publishes them to GitHub Releases with the updater manifest.

### Self-hosted CDN (optional)

If you prefer a self-hosted update server, run:

```bash
pnpm tauri build
node scripts/generate-updater-manifest.js https://cdn.example.com/work-station dist/latest.json
```

Then point `tauri.conf.json` → `plugins.updater.endpoints` to your hosted `latest.json` URL.

## Status

🚧 Early development — see [PROJECT_PLAN.md](./PROJECT_PLAN.md) for the roadmap.

## License

[MIT](./LICENSE)
