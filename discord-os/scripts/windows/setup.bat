@echo off
chcp 65001 >nul
title Discord OS - Einrichtung
cd /d "%~dp0\..\.."

where node >nul 2>nul
if errorlevel 1 (
  echo [FEHLER] Node.js wurde nicht gefunden. Bitte Node.js 22 LTS von https://nodejs.org installieren.
  pause
  exit /b 1
)

where docker >nul 2>nul
if not errorlevel 1 (
  echo Starte PostgreSQL und Redis ueber Docker ...
  docker compose up -d postgres redis
)

node scripts\setup.mjs
pause
