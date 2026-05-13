# Work Station Mobile (PWA)

Companion Progressive Web App for [Work Station](../README.md). Connects to the
desktop app's WebSocket bridge (`ws://<host>:7420/ws`) for remote terminal,
tasks, and system monitor access.

## Stack

- [SolidStart](https://start.solidjs.com/) (Vinxi + Solid.js)
- TypeScript
- Tailwind CSS v4 (via `@tailwindcss/vite`)
- [`vite-plugin-pwa`](https://vite-pwa-org.netlify.app/) (Workbox)

## Scripts

```bash
pnpm install      # install deps (run from this directory)
pnpm dev          # start dev server on http://localhost:3000
pnpm build        # produce static PWA bundle in .output/public
pnpm start        # serve the production build
pnpm typecheck    # TypeScript only
```

## Shared types

Type definitions are imported from the desktop app via the `@shared/*` alias
(see `tsconfig.json`), pointing at `../src/types/`. Keep wire-protocol types in
that directory so both ends stay in sync.

## Status

Scaffold only (T18.7). Auth, WebSocket client, terminal, tasks, projects, and
monitor land in T18.8 through T18.14.
