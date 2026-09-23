# dsh-platform stop script
# Stops gateway, portal, orphan dsh runtime children, and Redis.
#
# NOTE: the gateway listener is a child of `tsx watch`; its command line is just
# "src/index.ts" and does NOT contain "@dsh-platform/gateway" or "tsx watch".
# tsx watch also restarts the child after it is killed. So we match every
# node/cmd/pnpm process whose command line references the repo folder name
# ("dsh-platform", also present in URL-encoded forms), kill the whole tree
# (taskkill /T), and finally free ports 8080/5173 as a safety net.

$root = $PSScriptRoot

Write-Host "Stopping dsh-platform services..." -ForegroundColor Cyan

# 1. Kill repo-related process trees by command-line match.
$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='cmd.exe' OR Name='pnpm.cmd'" |
    Where-Object { $cl = $_.CommandLine; $cl -and $cl -like '*dsh-platform*' }

if ($procs) {
    $seen = @{}
    foreach ($p in $procs) {
        if ($seen.ContainsKey($p.ProcessId)) { continue }
        $seen[$p.ProcessId] = $true
        Write-Host "Stopped $($p.Name) (PID: $($p.ProcessId))" -ForegroundColor DarkGray
        cmd /c "taskkill /PID $($p.ProcessId) /T /F" 2>$null | Out-Null
    }
} else {
    Write-Host "No gateway/portal processes found" -ForegroundColor DarkGray
}

# 2. Safety net: free listening ports (8080=gateway, 5173=portal).
foreach ($port in 8080, 5173) {
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($conn) {
        foreach ($procId in ($conn | Select-Object -ExpandProperty OwningProcess -Unique)) {
            Write-Host "Freeing port $port (PID: $procId)" -ForegroundColor DarkGray
            cmd /c "taskkill /PID $procId /T /F" 2>$null | Out-Null
        }
    }
}

# 3. Stop Redis (if started by start.ps1)
$redis = Get-Process -Name "redis-server" -ErrorAction SilentlyContinue
if ($redis) {
    $redis | Stop-Process -Force
    Write-Host "Stopped Redis" -ForegroundColor Green
} else {
    Write-Host "Redis not running" -ForegroundColor DarkGray
}

Write-Host "All services stopped" -ForegroundColor Green
