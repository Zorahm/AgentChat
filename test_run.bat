@echo off
set choice=3
goto prepare_both

:prepare_both
echo Preparing both...
call :init_backend
if errorlevel 1 goto init_failed
goto both

:init_failed
echo [Error] Backend initialization failed.
pause
goto end

:both
echo Starting backend + UI in separate windows...
start "Backend" cmd /k "cd /d %~dp0backend && call .venv\Scripts\activate.bat && python -m uvicorn main:app --host 127.0.0.1 --port 8787 || echo. & echo [backend crashed - leaving window open]"
timeout /t 2 /nobreak >nul
start "UI" cmd /k "cd /d %~dp0ui && npm run dev || echo. & echo [UI crashed - leaving window open]"
echo Backend: http://127.0.0.1:8787
echo UI:     http://localhost:5173
echo.
pause
goto end

:init_backend
echo Init backend start...
cd /d "%~dp0backend"
if exist .venv\Scripts\activate.bat (
    echo [System] Virtual environment venv found. Activating...
    call .venv\Scripts\activate.bat
    exit /b 0
)
echo Should not reach here because venv exists!
exit /b 1

:end
echo End of script.
