@echo off
chcp 65001 >nul
title Instalator — Debate Live Translator (PL -^> EN)
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
if %errorlevel% neq 0 (
    echo.
    echo [!] Wystapil problem podczas instalacji. Sprawdz komunikaty powyzej.
    pause
    exit /b %errorlevel%
)

echo Czy chcesz od razu uruchomic aplikacje Debate Live Translator? (T/N)
set /p RUN_NOW="Wybor [T]: "
if /i "%RUN_NOW%"=="" set RUN_NOW=T
if /i "%RUN_NOW%"=="T" (
    call "%~dp0Uruchom_Translator.bat"
)
