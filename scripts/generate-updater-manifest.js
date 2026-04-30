#!/usr/bin/env node
/**
 * Generate a self-hosted updater manifest (latest.json) from local build artifacts.
 * Useful when switching from GitHub Releases to a self-hosted CDN (S3, R2, etc.).
 *
 * Usage:
 *   node scripts/generate-updater-manifest.js <base-url> [output-path]
 *
 * Example:
 *   node scripts/generate-updater-manifest.js https://cdn.example.com/work-station dist/latest.json
 *
 * The script scans bundle folders under src-tauri/target/ for .dmg, .app.tar.gz, .msi, and .exe
 * files and produces a Tauri v2 compatible latest.json manifest.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "fs";
import { createHash } from "crypto";
import { resolve, basename, join } from "path";

const __root = resolve(import.meta.dirname, "..");

function sha256(filePath) {
  const buffer = readFileSync(filePath);
  return createHash("sha256").update(buffer).digest("hex");
}

function findSignatures(bundlePath) {
  const sigPaths = [
    `${bundlePath}.sig`,
    bundlePath.replace(/\.tar\.gz$/, "").replace(/\.app\.tar\.gz$/, ".app") + ".sig",
  ];
  for (const p of sigPaths) {
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

  if (!baseUrl) {
    console.error("Usage: node scripts/generate-updater-manifest.js <base-url> [output-path]");
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

  // Search for bundles in target directories
  const bundleDirs = [
    resolve(__root, "src-tauri", "target", "aarch64-apple-darwin", "release", "bundle"),
    resolve(__root, "src-tauri", "target", "x86_64-apple-darwin", "release", "bundle"),
    resolve(__root, "src-tauri", "target", "x86_64-pc-windows-msvc", "release", "bundle"),
    resolve(__root, "src-tauri", "target", "release", "bundle"),
  ];

  const seen = new Set();

  for (const dir of bundleDirs) {
    if (!existsSync(dir)) continue;

    // macOS .app.tar.gz (universal or arch-specific)
    const macBundles = globFiles(dir, /\.app\.tar\.gz$/);
    for (const bundle of macBundles) {
      const sig = findSignatures(bundle);
      if (!sig) {
        console.warn(`⚠️  No signature found for ${bundle}, skipping.`);
        continue;
      }
      const url = `${baseUrl.replace(/\/$/, "")}/${basename(bundle)}`;
      manifest.platforms["darwin-aarch64"] = { signature: sig, url };
      manifest.platforms["darwin-x86_64"] = { signature: sig, url };
      seen.add("darwin");
    }

    // Windows .msi
    const msiBundles = globFiles(dir, /\.msi$/);
    for (const bundle of msiBundles) {
      const sig = findSignatures(bundle);
      if (!sig) {
        console.warn(`⚠️  No signature found for ${bundle}, skipping.`);
        continue;
      }
      const url = `${baseUrl.replace(/\/$/, "")}/${basename(bundle)}`;
      manifest.platforms["windows-x86_64"] = { signature: sig, url };
      seen.add("windows");
    }

    // Windows .exe (NSIS) — prefer MSI for updater, but include if no MSI
    const nsisBundles = globFiles(dir, /\.exe$/)
      .filter((p) => !p.endsWith(".msi") && !basename(p).includes("Updater"));
    if (!manifest.platforms["windows-x86_64"] && nsisBundles.length > 0) {
      const bundle = nsisBundles[0];
      const sig = findSignatures(bundle);
      if (sig) {
        const url = `${baseUrl.replace(/\/$/, "")}/${basename(bundle)}`;
        manifest.platforms["windows-x86_64"] = { signature: sig, url };
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
