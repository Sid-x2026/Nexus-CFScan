@echo off
REM Build nexus-cfscan-agent on Windows (no network needed, stdlib only).
cd /d %~dp0
go vet ./...
if errorlevel 1 exit /b 1
go build -o cfscan-agent.exe .
if errorlevel 1 exit /b 1
echo Built cfscan-agent.exe — run it, then open the Nexus-CFScan page.
