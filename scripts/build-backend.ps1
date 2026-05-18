# Build the Python backend into a single exe sidecar for Tauri.
# Output: src-tauri/binaries/backend-x86_64-pc-windows-msvc.exe

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$binDir = Join-Path $root "src-tauri\binaries"

Write-Host "==> Installing build dependencies..."
pip install pyinstaller --quiet

Write-Host "==> Running PyInstaller..."
Set-Location (Join-Path $root "backend")

pyinstaller run.py `
    --onefile `
    --name backend `
    --distpath (Join-Path $root "src-tauri\binaries") `
    --workpath (Join-Path $root "build\pyinstaller-work") `
    --specpath (Join-Path $root "build\pyinstaller-spec") `
    --noconfirm `
    --collect-data litellm `
    --hidden-import uvicorn.logging `
    --hidden-import uvicorn.loops `
    --hidden-import uvicorn.loops.auto `
    --hidden-import uvicorn.protocols `
    --hidden-import uvicorn.protocols.http `
    --hidden-import uvicorn.protocols.http.auto `
    --hidden-import uvicorn.lifespan `
    --hidden-import uvicorn.lifespan.on `
    --hidden-import uvicorn.lifespan.off `
    --hidden-import anyio._backends._asyncio

Set-Location $root

Write-Host "==> Renaming to Tauri target triple..."
$src = Join-Path $binDir "backend.exe"
$dst = Join-Path $binDir "backend-x86_64-pc-windows-msvc.exe"
if (Test-Path $dst) { Remove-Item $dst -Force }
Rename-Item $src $dst

Write-Host "==> Done: $dst"
