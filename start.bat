@echo off
title Xbox Profile Dashboard
cd /d "%~dp0"

echo.
echo   Xbox Profile Dashboard
echo   ----------------------
echo   Starting server on http://localhost:8000
echo   Press Ctrl+C to stop
echo.

:: Open browser after a short delay (gives server time to bind the port)
start "" cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:8000"

:: Run uvicorn (stays in foreground — terminal shows logs)
set XBOX_DEV=1
python -m uvicorn main:app --reload --port 8000
