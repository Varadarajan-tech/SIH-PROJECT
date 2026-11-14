@echo off
rem SAMVEDNA launcher - starts the app on http://localhost:3000
rem Configuration (API keys) lives in D:\SIH\.env
cd /d D:\SIH
set PORT=3000
D:\SIH\Node\node.exe server.js > server.log 2>&1
