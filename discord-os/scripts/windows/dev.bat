@echo off
chcp 65001 >nul
title Discord OS - Entwicklung
cd /d "%~dp0\..\.."
where docker >nul 2>nul
if not errorlevel 1 docker compose up -d postgres redis >nul 2>nul
echo Entwicklungsmodus: Dashboard unter http://localhost:5173 (PUBLIC_URL in .env entsprechend setzen)
call npm run dev
pause
