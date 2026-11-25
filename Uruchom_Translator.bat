@echo off
chcp 65001 >nul
title Debate Live Translator (Live AI)
cd /d "%~dp0"

echo ====================================================================
echo   Uruchamianie Debate Live Translator (Live AI)...
echo ====================================================================

if exist "%~dp0.python_exe" (
    set /p PY_EXE=<"%~dp0.python_exe"
    if exist "%PY_EXE%" (
        "%PY_EXE%" -c "import numpy, onnxruntime, pypdfium2, tkinter" >nul 2>nul
        if %errorlevel% equ 0 (
            "%PY_EXE%" server.py
            goto :eof
        )
    )
)

if exist "%~dp0.venv\Scripts\python.exe" (
    "%~dp0.venv\Scripts\python.exe" -c "import numpy, onnxruntime, pypdfium2, tkinter" >nul 2>nul
    if %errorlevel% equ 0 (
        "%~dp0.venv\Scripts\python.exe" server.py
        goto :eof
    )
)

where python >nul 2>nul
if %errorlevel% equ 0 (
    python -c "import numpy, onnxruntime, pypdfium2, tkinter" >nul 2>nul
    if %errorlevel% equ 0 (
        python server.py
        goto :eof
    )
)

echo [INFO] Pierwsze uruchomienie lub brakujace biblioteki — uruchamiam automatyczna konfiguracje...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
if exist "%~dp0.python_exe" (
    set /p PY_EXE=<"%~dp0.python_exe"
    "%PY_EXE%" server.py
) else if exist "%~dp0.venv\Scripts\python.exe" (
    "%~dp0.venv\Scripts\python.exe" server.py
) else (
    python server.py
)
pause
