# dsh-platform stop script
# Gracefully stops gateway, portal, and Redis

$root = $PSScriptRoot

Write-Host "Stopping dsh-platform services..." -ForegroundColor Cyan

# 1. Find and stop gateway + portal processes by their working directory
$nodeProcesses = Get-CimInstance -ClassName Win32_Process -Filter "Name = 'node.exe' OR Name = 'node'" |
    Where-Object { $_.CommandLine -like "*@dsh-platform/gateway*" -or $_.CommandLine -like "*@dsh-platform/portal*" -or $_.CommandLine -like "*tsx watch*" }

if ($nodeProcesses) {
    $nodeProcesses | ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        Write-Host "Stopped node process (PID: $($_.ProcessId))" -ForegroundColor DarkGray
    }
} else {
    Write-Host "No gateway/portal processes found" -ForegroundColor DarkGray
}

# 2. Stop Redis (if started by start.ps1)
$redis = Get-Process -Name "redis-server" -ErrorAction SilentlyContinue
if ($redis) {
    $redis | Stop-Process -Force
    Write-Host "Stopped Redis" -ForegroundColor Green
} else {
    Write-Host "Redis not running" -ForegroundColor DarkGray
}

Write-Host "All services stopped" -ForegroundColor Green