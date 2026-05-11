# T10.2: cold-start benchmark on Windows via hyperfine.
# Requires `hyperfine` (scoop install hyperfine) and a release build at
# src-tauri\target\release\work-station.exe. Builds it if missing.

$ErrorActionPreference = 'Stop'

$RepoRoot = Resolve-Path "$PSScriptRoot\..\.."
$Bin = Join-Path $RepoRoot 'src-tauri\target\release\work-station.exe'

if (-not (Get-Command hyperfine -ErrorAction SilentlyContinue)) {
  Write-Error "hyperfine not found. Install: scoop install hyperfine"
}

if (-not (Test-Path $Bin)) {
  Write-Host "release binary missing; running 'pnpm tauri build'..."
  Push-Location $RepoRoot
  try { pnpm tauri build } finally { Pop-Location }
}

$env:WS_BENCH_EXIT = '1'
hyperfine --warmup 3 -r 10 --shell=none "$Bin"
