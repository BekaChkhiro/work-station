#!/usr/bin/env node
/**
 * Semver version bump script.
 * Keeps package.json, src-tauri/Cargo.toml, src-tauri/tauri.conf.json
 * and Cargo.lock in lockstep.
 *
 * Usage: node scripts/bump-version.js [major|minor|patch]
 * Default bump is patch.
 */

import { readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = resolve(__dirname, "..");

const FILES = {
  packageJson: resolve(root, "package.json"),
  cargoToml: resolve(root, "src-tauri", "Cargo.toml"),
  tauriConf: resolve(root, "src-tauri", "tauri.conf.json"),
};

function readVersion(filePath, parser) {
  const content = readFileSync(filePath, "utf-8");
  return parser(content);
}

function parsePackageJson(content) {
  const json = JSON.parse(content);
  return { version: json.version, data: json };
}

function parseCargoToml(content) {
  const match = content.match(/^version\s*=\s*"([^"]+)"/m);
  if (!match) throw new Error("Could not find version in Cargo.toml");
  return { version: match[1], content };
}

function parseTauriConf(content) {
  const json = JSON.parse(content);
  return { version: json.version, data: json };
}

function bumpSemver(version, type) {
  const [major, minor, patch] = version.split(".").map(Number);
  if ([major, minor, patch].some((n) => Number.isNaN(n))) {
    throw new Error(`Invalid semver version: ${version}`);
  }

  switch (type) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    default:
      throw new Error(`Unknown bump type: ${type}`);
  }
}

function updatePackageJson(filePath, data, newVersion) {
  data.version = newVersion;
  writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

function updateCargoToml(filePath, content, newVersion) {
  const updated = content.replace(
    /^(version\s*=\s*")([^"]+)(")/m,
    `$1${newVersion}$3`
  );
  writeFileSync(filePath, updated);
}

function updateTauriConf(filePath, data, newVersion) {
  data.version = newVersion;
  writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

function main() {
  const bumpType = process.argv[2] || "patch";
  if (!["major", "minor", "patch"].includes(bumpType)) {
    console.error(`Usage: node scripts/bump-version.js [major|minor|patch]`);
    process.exit(1);
  }

  const pkg = readVersion(FILES.packageJson, parsePackageJson);
  const cargo = readVersion(FILES.cargoToml, parseCargoToml);
  const tauri = readVersion(FILES.tauriConf, parseTauriConf);

  const versions = [
    { name: "package.json", version: pkg.version },
    { name: "Cargo.toml", version: cargo.version },
    { name: "tauri.conf.json", version: tauri.version },
  ];

  const allSame = versions.every((v) => v.version === versions[0].version);
  if (!allSame) {
    console.error("❌ Versions are out of sync:");
    for (const v of versions) {
      console.error(`   ${v.name}: ${v.version}`);
    }
    process.exit(1);
  }

  const current = versions[0].version;
  const next = bumpSemver(current, bumpType);

  console.log(`🔖 Bumping ${bumpType}: ${current} → ${next}`);

  updatePackageJson(FILES.packageJson, pkg.data, next);
  updateCargoToml(FILES.cargoToml, cargo.content, next);
  updateTauriConf(FILES.tauriConf, tauri.data, next);

  // Update Cargo.lock by running cargo generate-lockfile inside src-tauri
  try {
    console.log("🔒 Updating Cargo.lock...");
    execSync("cargo generate-lockfile", {
      cwd: resolve(root, "src-tauri"),
      stdio: "inherit",
    });
  } catch {
    console.warn("⚠️  Could not update Cargo.lock automatically. Run `cargo generate-lockfile` manually in src-tauri/.");
  }

  console.log("✅ Version bumped successfully.");
  console.log("");
  console.log("Next steps:");
  console.log(`   git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json src-tauri/Cargo.lock`);
  console.log(`   git commit -m "chore(release): bump version to ${next}"`);
}

main();
