@echo off
echo.
echo === AgentChat ===
echo.
echo 1. Backend only
echo 2. UI dev only
echo 3. Both (separate windows)
echo 4. Tauri desktop
echo.
set /p choice=Choose (1-4): 

if "%choice%"=="1" goto backend
if "%choice%"=="2" goto ui
if "%choice%"=="3" goto both
if "%choice%"=="4" goto tauri
goto end

:backend
echo Starting backend on http://127.0.0.1:8787 ...
cd /d "%~dp0backend"
uvicorn main:app --host 127.0.0.1 --port 8787 --reload
echo.
echo [backend process exited]
pause
goto end

:ui
echo Starting UI on http://localhost:5173 ...
cd /d "%~dp0ui"
npm run dev
goto end

:both
echo Starting backend + UI in separate windows...
start "Backend" cmd /k "cd /d %~dp0backend && uvicorn main:app --host 127.0.0.1 --port 8787 || echo. & echo [backend crashed - leaving window open]"
timeout /t 2 /nobreak >nul
start "UI" cmd /k "cd /d %~dp0ui && npm run dev || echo. & echo [UI crashed - leaving window open]"
echo Backend: http://127.0.0.1:8787
echo UI:     http://localhost:5173
echo.
pause
goto end

:tauri
echo Building and launching Tauri desktop app...
cd /d "%~dp0src-tauri"
cargo tauri dev
goto end

:end
