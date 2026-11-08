@echo off
chcp 65001 >nul
title Discord OS
cd /d "%~dp0\..\.."

if not exist ".env" (
  echo [FEHLER] Keine .env gefunden. Bitte zuerst scripts\windows\setup.bat ausfuehren.
  pause
  exit /b 1
)
if not exist "server\dist\index.js" (
  echo Anwendung ist noch nicht gebaut - baue jetzt ...
  call npm run build || (pause & exit /b 1)
)

where docker >nul 2>nul
if not errorlevel 1 docker compose up -d postgres redis >nul 2>nul

echo Discord OS startet ... (Beenden mit Strg+C)
:loop
call npm start
echo.
echo Discord OS wurde beendet. Neustart in 5 Sekunden ... (Strg+C zum Abbrechen)
timeout /t 5 >nul
goto loop
