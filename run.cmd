@echo off
rem Start Agent Office (Windows). Set PORT / HOST / ARCHIVE_DAYS first to override defaults.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 22.5+ is required: https://nodejs.org & exit /b 1)
node --no-warnings server.js
