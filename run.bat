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

if "%choice%"=="1" goto prepare_backend
if "%choice%"=="2" goto ui
if "%choice%"=="3" goto prepare_both
if "%choice%"=="4" goto tauri
goto end

:prepare_backend
call :init_backend
if errorlevel 1 goto init_failed
goto backend

:prepare_both
call :init_backend
if errorlevel 1 goto init_failed
goto both

:init_failed
echo [Error] Backend initialization failed.
pause
goto end

:backend
echo Starting backend on http://127.0.0.1:8787 ...
cd /d "%~dp0backend"
python -m uvicorn main:app --host 127.0.0.1 --port 8787 --reload
echo.
echo [backend process exited]
pause
goto end

:ui
echo Starting UI on http://localhost:5173 ...
cd /d "%~dp0ui"
if not exist node_modules (
    echo [System] Installing UI dependencies...
    npm install
    if errorlevel 1 (
        echo [Error] npm install failed.
        pause
        goto end
    )
)
npm run dev
goto end

:both
echo Starting backend + UI in separate windows...
start "Backend" cmd /k "cd /d %~dp0backend && call .venv\Scripts\activate.bat && python -m uvicorn main:app --host 127.0.0.1 --port 8787 || echo. & echo [backend crashed - leaving window open]"
timeout /t 2 /nobreak >nul
start "UI" cmd /k "cd /d %~dp0ui && (if not exist node_modules npm install) && npm run dev || echo. & echo [UI crashed - leaving window open]"
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

:init_backend
cd /d "%~dp0backend"
if exist .venv\Scripts\activate.bat (
    echo [System] Virtual environment venv found. Activating...
    call .venv\Scripts\activate.bat
    exit /b 0
)

echo.
echo =========================================
echo   Creating Python Virtual Environment
echo =========================================
echo Virtual environment venv not found. Creating...
py -m venv .venv
if errorlevel 1 (
    echo [Warning] Failed to create virtual environment with 'py -m venv'. Trying 'python -m venv'...
    python -m venv .venv
    if errorlevel 1 (
        echo [Error] Failed to create virtual environment. Please install virtualenv manually or run 'pip install -r requirements.txt' globally.
        exit /b 1
    )
)

echo [Success] Virtual environment venv created.
echo Installing dependencies from requirements.txt...
call .venv\Scripts\activate.bat
python -m pip install --upgrade pip
pip install -r requirements.txt
if errorlevel 1 (
    echo [Error] Failed to install dependencies.
    exit /b 1
)
echo [Success] Dependencies installed successfully.
echo.
exit /b 0

:end
