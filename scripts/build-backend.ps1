# Build the Python backend into a single exe sidecar for Tauri.
# Output: src-tauri/binaries/agentchat-backend-x86_64-pc-windows-msvc.exe

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$binDir = Join-Path $root "src-tauri\binaries"

Write-Host "==> Installing build dependencies..."
pip install pyinstaller --quiet

Write-Host "==> Pre-downloading tiktoken encoding files..."
$tiktokenCache = Join-Path $root "build\tiktoken-cache"
if (Test-Path $tiktokenCache) { Remove-Item $tiktokenCache -Recurse -Force }
New-Item -ItemType Directory -Force -Path $tiktokenCache | Out-Null
$env:TIKTOKEN_CACHE_DIR = $tiktokenCache
python -c "import tiktoken; [tiktoken.get_encoding(e) for e in ('cl100k_base','p50k_base','r50k_base','o200k_base')]"
Write-Host "==> tiktoken cache: $tiktokenCache"
Get-ChildItem $tiktokenCache | ForEach-Object { Write-Host "    $($_.Name)" }

Write-Host "==> Ensuring built UI (ui/dist) to bundle for remote/phone serving..."
$uiDist = Join-Path $root "ui\dist"
if (-not (Test-Path (Join-Path $uiDist "index.html"))) {
    Write-Host "    ui/dist missing — running 'npm run build'..."
    Push-Location (Join-Path $root "ui")
    npm run build
    Pop-Location
}
if (-not (Test-Path (Join-Path $uiDist "index.html"))) {
    throw "ui/dist/index.html not found after build — cannot bundle UI into backend."
}

Write-Host "==> Locating bundled skills (skills/)..."
$skillsBundle = Join-Path $root "skills"
if (-not (Test-Path $skillsBundle)) {
    throw "skills/ not found — cannot bundle skills into backend."
}

Write-Host "==> Locating bundled ComfyUI workflows..."
# Data files, so PyInstaller's import scan never sees them; without this
# --add-data the ComfyUI image backend has no graph to submit.
$workflowsBundle = Join-Path $root "backend\images\workflows"
if (-not (Test-Path (Join-Path $workflowsBundle "txt2img.json"))) {
    throw "backend/images/workflows not found — cannot bundle image workflows into backend."
}

Write-Host "==> Stamping build version (single source: tauri.conf.json)..."
# The Tauri shell compares this against /api/health to detect a stale sidecar
# left running on 8787 after an update. main.py imports _buildstamp, so
# PyInstaller bundles it; the file is absent in dev (→ BUILD_VERSION="dev").
$confPath = Join-Path $root "src-tauri\tauri.conf.json"
$ver = (Get-Content $confPath -Raw | ConvertFrom-Json).version
$stamp = Join-Path $root "backend\_buildstamp.py"
Set-Content -Path $stamp -Value "BUILD_VERSION = `"$ver`"" -Encoding utf8
Write-Host "    BUILD_VERSION = $ver"

Write-Host "==> Running PyInstaller..."
Set-Location (Join-Path $root "backend")

# The keyring hidden-imports below are load-bearing: store/secret_store.py
# imports the backend lazily inside a function, so PyInstaller's static scan
# never sees it. Drop them and the frozen sidecar silently loses the keychain
# and writes API keys to the plaintext fallback instead.
pyinstaller run.py `
    --onefile `
    --name agentchat-backend `
    --distpath (Join-Path $root "src-tauri\binaries") `
    --workpath (Join-Path $root "build\pyinstaller-work") `
    --specpath (Join-Path $root "build\pyinstaller-spec") `
    --noconfirm `
    --collect-all litellm `
    --collect-all tiktoken `
    --collect-all tiktoken_ext `
    --collect-all watchdog `
    --collect-data certifi `
    --hidden-import uvicorn.logging `
    --hidden-import uvicorn.loops `
    --hidden-import uvicorn.loops.auto `
    --hidden-import uvicorn.protocols `
    --hidden-import uvicorn.protocols.http `
    --hidden-import uvicorn.protocols.http.auto `
    --hidden-import uvicorn.lifespan `
    --hidden-import uvicorn.lifespan.on `
    --hidden-import uvicorn.lifespan.off `
    --hidden-import anyio._backends._asyncio `
    --hidden-import python_multipart `
    --hidden-import keyring.backends.Windows `
    --hidden-import keyring.backends.chainer `
    --hidden-import keyring.backends.fail `
    --hidden-import win32ctypes.core `
    --add-data "${tiktokenCache};tiktoken_cache" `
    --add-data "${uiDist};ui_dist" `
    --add-data "${skillsBundle};bundled_skills" `
    --add-data "${workflowsBundle};image_workflows"

Set-Location $root

Write-Host "==> Renaming to Tauri target triple..."
$src = Join-Path $binDir "agentchat-backend.exe"
$dst = Join-Path $binDir "agentchat-backend-x86_64-pc-windows-msvc.exe"
if (Test-Path $dst) { Remove-Item $dst -Force }
Rename-Item $src $dst

Write-Host "==> Done: $dst"
