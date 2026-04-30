#!/usr/bin/env python3
"""Index only relevant source files into PlanFlow using explicit files mode.

PlanFlow's directory scanner has hardcoded include/exclude lists that:
- Do NOT include .rs (Rust) or .toml files
- Do NOT exclude src-tauri/target/ (Rust build artifacts)
- Do NOT respect .gitignore at all

This script collects the actual source + doc files we care about and
prints them as JSON batches suitable for `planflow_index(files=...)`.

Usage:
    python3 scripts/planflow-index.py        # print batch info
    python3 scripts/planflow-index.py --dump # write batch JSONs to /tmp
"""

import json
import os
import sys

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Files and extensions we want indexed.
# Order matters: we include specific paths and glob-like extensions.
WANTED_PATHS = [
    ".github/workflows/build.yml",
    ".vscode/extensions.json",
    "AGENTS.md",
    "CONTRIBUTING.md",
    "PROJECT_PLAN.md",
    "README.md",
    "eslint.config.js",
    "index.html",
    "package.json",
    "tsconfig.json",
    "tsconfig.node.json",
    "vite.config.ts",
    "src-tauri/Cargo.toml",
    "src-tauri/build.rs",
    "src-tauri/tauri.conf.json",
    "src-tauri/capabilities/default.json",
    "src-tauri/examples/ipc_throughput.rs",
    "src-tauri/src/commands/mod.rs",
    "src-tauri/src/db/mod.rs",
    "src-tauri/src/ipc/mod.rs",
    "src-tauri/src/lib.rs",
    "src-tauri/src/main.rs",
    "src-tauri/src/pty/manager.rs",
    "src-tauri/src/pty/mod.rs",
    "src-tauri/src/pty/scrollback.rs",
    "src-tauri/src/pty/session.rs",
    "src/App.tsx",
    "src/components/index.ts",
    "src/db/index.ts",
    "src/db/schema.ts",
    "src/index.tsx",
    "src/ipc/index.ts",
    "src/routes/index.ts",
    "src/stores/theme.ts",
    "src/styles/index.css",
    "src/styles/tokens.css",
    "src/vite-env.d.ts",
]

BATCH_SIZE = 8


def collect_files():
    files = []
    for rel_path in WANTED_PATHS:
        abs_path = os.path.join(PROJECT_ROOT, rel_path)
        if not os.path.isfile(abs_path):
            print(f"Warning: missing {rel_path}", file=sys.stderr)
            continue
        with open(abs_path, "r", encoding="utf-8") as f:
            content = f.read()
        files.append({"path": rel_path, "content": content})
    return files


def main():
    files = collect_files()
    total = len(files)
    batches = [files[i : i + BATCH_SIZE] for i in range(0, total, BATCH_SIZE)]

    print(f"Total files: {total}")
    print(f"Batches: {len(batches)} (size {BATCH_SIZE})")
    print()

    for idx, batch in enumerate(batches, 1):
        batch_bytes = sum(len(f["content"].encode("utf-8")) for f in batch)
        print(f"Batch {idx}: {len(batch)} files, ~{batch_bytes / 1024:.1f} KB")
        for f in batch:
            print(f"  - {f['path']}")

    if "--dump" in sys.argv:
        os.makedirs("/tmp/planflow-batches", exist_ok=True)
        for idx, batch in enumerate(batches, 1):
            path = f"/tmp/planflow-batches/batch-{idx}.json"
            with open(path, "w", encoding="utf-8") as f:
                json.dump(batch, f)
            print(f"Wrote {path}")


if __name__ == "__main__":
    main()
