#!/usr/bin/env node
/**
 * Generate a Tauri v2 compatible updater manifest (latest.json) from build artifacts.
 *
 * Supports both local target directories and custom scan directories (useful in CI).
 *
 * Usage:
 *   node scripts/generate-updater-manifest.js <base-url> [output-path] [extra-scan-dirs...]
 *
 * Examples:
 *   node scripts/generate-updater-manifest.js https://cdn.example.com/work-station dist/latest.json
 *   node scripts/generate-updater-manifest.js https://github.com/user/repo/releases/download/v1.0.0 latest.json artifacts/bundles-macos-arm64 artifacts/bundles-windows-x64
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "fs";
import { resolve, basename, join } from "path";

const __root = resolve(import.meta.dirname, "..");

function findSignature(bundlePath) {
  const candidates = [
    `${bundlePath}.sig`,
    bundlePath.replace(/\.tar\.gz$/, "").replace(/\.app\.tar\.gz$/, ".app") + ".sig",
  ];
  for (const p of candidates) {
    if (existsSync(p)) return readFileSync(p, "utf-8").trim();
  }
  return null;
}

function globFiles(dir, pattern) {
  const results = [];
  function walk(current) {
    if (!existsSync(current)) return;
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (pattern.test(entry)) {
        results.push(full);
      }
    }
  }
  walk(dir);
  return results;
}

function main() {
  const baseUrl = process.argv[2];
  const outputPath = process.argv[3] || resolve(__root, "dist", "latest.json");
  const extraDirs = process.argv.slice(4).map((d) => resolve(d));

  if (!baseUrl) {
    console.error("Usage: node scripts/generate-updater-manifest.js <base-url> [output-path] [extra-scan-dirs...]");
    process.exit(1);
  }

  // Read version from tauri.conf.json
  const tauriConfPath = resolve(__root, "src-tauri", "tauri.conf.json");
  const tauriConf = JSON.parse(readFileSync(tauriConfPath, "utf-8"));
  const version = tauriConf.version;

  const manifest = {
    version,
    notes: `Work Station ${version}`,
    pub_date: new Date().toISOString(),
    platforms: {},
  };

  // Default target bundle directories + any extras from CLI
  const bundleDirs = [
    resolve(__root, "src-tauri", "target", "aarch64-apple-darwin", "release", "bundle"),
    resolve(__root, "src-tauri", "target", "x86_64-apple-darwin", "release", "bundle"),
    resolve(__root, "src-tauri", "target", "x86_64-pc-windows-msvc", "release", "bundle"),
    resolve(__root, "src-tauri", "target", "aarch64-pc-windows-msvc", "release", "bundle"),
    resolve(__root, "src-tauri", "target", "release", "bundle"),
    ...extraDirs,
  ];

  const seen = new Set();

  for (const dir of bundleDirs) {
    if (!existsSync(dir)) continue;

    // ── macOS .app.tar.gz ──
    const macBundles = globFiles(dir, /\.app\.tar\.gz$/);
    for (const bundle of macBundles) {
      const sig = findSignature(bundle);
      if (!sig) {
        console.warn(`⚠️  No signature found for ${bundle}, skipping.`);
        continue;
      }
      const url = `${baseUrl.replace(/\/$/, "")}/${basename(bundle)}`;
      manifest.platforms["darwin-aarch64"] = { signature: sig, url };
      manifest.platforms["darwin-x86_64"] = { signature: sig, url };
      seen.add("darwin");
    }

    // ── Windows MSI updater bundle (.msi.zip for Tauri v2) ──
    const msiZipBundles = globFiles(dir, /\.msi\.zip$/);
    for (const bundle of msiZipBundles) {
      const sig = findSignature(bundle);
      if (!sig) {
        console.warn(`⚠️  No signature found for ${bundle}, skipping.`);
        continue;
      }
      const url = `${baseUrl.replace(/\/$/, "")}/${basename(bundle)}`;
      // Detect architecture from bundle path or filename
      const isArm64 = bundle.includes("aarch64") || bundle.includes("arm64");
      const platformKey = isArm64 ? "windows-aarch64" : "windows-x86_64";
      if (!manifest.platforms[platformKey]) {
        manifest.platforms[platformKey] = { signature: sig, url };
        seen.add("windows");
      }
    }

    // ── Windows NSIS updater bundle (.nsis.zip for Tauri v2) ──
    const nsisZipBundles = globFiles(dir, /\.nsis\.zip$/);
    for (const bundle of nsisZipBundles) {
      const isArm64 = bundle.includes("aarch64") || bundle.includes("arm64");
      const platformKey = isArm64 ? "windows-aarch64" : "windows-x86_64";
      if (manifest.platforms[platformKey]) continue; // prefer MSI
      const sig = findSignature(bundle);
      if (!sig) {
        console.warn(`⚠️  No signature found for ${bundle}, skipping.`);
        continue;
      }
      const url = `${baseUrl.replace(/\/$/, "")}/${basename(bundle)}`;
      manifest.platforms[platformKey] = { signature: sig, url };
      seen.add("windows");
    }

    // ── Fallback: raw .msi (legacy / non-zip) ──
    const msiBundles = globFiles(dir, /\.msi$/);
    for (const bundle of msiBundles) {
      const isArm64 = bundle.includes("aarch64") || bundle.includes("arm64");
      const platformKey = isArm64 ? "windows-aarch64" : "windows-x86_64";
      if (manifest.platforms[platformKey]) continue;
      const sig = findSignature(bundle);
      if (!sig) {
        console.warn(`⚠️  No signature found for ${bundle}, skipping.`);
        continue;
      }
      const url = `${baseUrl.replace(/\/$/, "")}/${basename(bundle)}`;
      manifest.platforms[platformKey] = { signature: sig, url };
      seen.add("windows");
    }

    // ── Fallback: NSIS .exe (legacy / non-zip) ──
    const nsisBundles = globFiles(dir, /\.exe$/).filter(
      (p) => !p.endsWith(".msi") && !basename(p).includes("Updater")
    );
    for (const bundle of nsisBundles) {
      const isArm64 = bundle.includes("aarch64") || bundle.includes("arm64");
      const platformKey = isArm64 ? "windows-aarch64" : "windows-x86_64";
      if (manifest.platforms[platformKey]) continue;
      const sig = findSignature(bundle);
      if (sig) {
        const url = `${baseUrl.replace(/\/$/, "")}/${basename(bundle)}`;
        manifest.platforms[platformKey] = { signature: sig, url };
        seen.add("windows");
      }
    }
  }

  if (seen.size === 0) {
    console.error("❌ No signed bundles found. Build the app first with `pnpm tauri build`.");
    process.exit(1);
  }

  writeFileSync(outputPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`✅ Manifest written to ${outputPath}`);
  console.log(`   Platforms: ${Array.from(seen).join(", ")}`);
  console.log(`   Version:   ${version}`);
}

main();
