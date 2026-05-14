/* global console, process */
// Vinxi places vite-plugin-pwa output (sw.js, workbox-*.js,
// manifest.webmanifest, registerSW.js) inside `.output/public/_build/`
// because that is the client asset dir. For the PWA to actually work
// the service worker must be served from `/` so its scope covers the
// whole app, and the manifest must be reachable at the URL referenced
// by `<link rel="manifest" href="/manifest.webmanifest">`.
//
// This script copies those four artefacts up one directory after the
// build. It also patches the absolute precache URLs in sw.js (Workbox
// records them relative to its own location — once moved, `assets/...`
// must become `/_build/assets/...` and bare names like
// `registerSW.js` become `/registerSW.js`).
//
// Run as `node scripts/postbuild.mjs` from the mobile/ directory.

import { readFileSync, writeFileSync, copyFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const OUT_ROOT = ".output/public";
const BUILD_DIR = join(OUT_ROOT, "_build");

function fail(msg) {
  console.error(`postbuild: ${msg}`);
  process.exit(1);
}

if (!existsSync(BUILD_DIR)) fail(`${BUILD_DIR} does not exist — did vinxi build run?`);

const buildEntries = readdirSync(BUILD_DIR);
const workboxName = buildEntries.find((n) => /^workbox-[A-Za-z0-9_-]+\.js$/.test(n));
if (!workboxName) fail("workbox-*.js not found in _build/");

// `registerSW.js` only exists when vite-plugin-pwa's `injectRegister`
// is not false. We register the SW manually from <UpdateToast />, so it
// is normally absent — keep the hoist optional.
const REQUIRED = ["sw.js", workboxName, "manifest.webmanifest"];
const OPTIONAL = ["registerSW.js"];
const hoisted = [];
for (const name of [...REQUIRED, ...OPTIONAL]) {
  const src = join(BUILD_DIR, name);
  if (!existsSync(src)) {
    if (REQUIRED.includes(name)) fail(`missing ${src}`);
    continue;
  }
  copyFileSync(src, join(OUT_ROOT, name));
  hoisted.push(name);
}

// Rewrite sw.js so the precache URLs resolve from the new root location.
// Each entry is `{url:"foo",revision:...}`. Bare names live at root,
// `assets/...` and `registerSW.js` now live under `/_build/`.
const swPath = join(OUT_ROOT, "sw.js");
let sw = readFileSync(swPath, "utf8");
const ROOT_LEVEL = new Set(["sw.js", "manifest.webmanifest", "registerSW.js", workboxName]);
sw = sw.replace(/\{url:"([^"]+)"/g, (match, url) => {
  if (url.startsWith("/") || url.startsWith("http")) return match;
  if (ROOT_LEVEL.has(url)) return `{url:"/${url}"`;
  return `{url:"/_build/${url}"`;
});
// `createHandlerBoundToURL("index.html")` must point at the real root.
sw = sw.replace(
  /createHandlerBoundToURL\("index\.html"\)/g,
  'createHandlerBoundToURL("/index.html")',
);
writeFileSync(swPath, sw);

// When registerSW.js is generated (legacy mode), vite-plugin-pwa bakes
// the SW path + scope into it from the build base (`/_build/`). Rewrite
// so it points at the hoisted `/sw.js` with root scope.
const registerPath = join(OUT_ROOT, "registerSW.js");
if (existsSync(registerPath)) {
  const registerSrc = readFileSync(registerPath, "utf8");
  const fixed = registerSrc
    .replace(/register\(['"][^'"]*sw\.js['"]/g, "register('/sw.js'")
    .replace(/scope:\s*['"][^'"]*['"]/g, "scope: '/'");
  if (fixed !== registerSrc) writeFileSync(registerPath, fixed);
}

console.log(`postbuild: hoisted ${hoisted.join(", ")} to ${OUT_ROOT}/`);
