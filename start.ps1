# dsh-platform startup script
# Gateway loads MySQL/Redis settings from the repo-root .env.
$root = $PSScriptRoot
$logDir = Join-Path $root "logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$gwLog = Join-Path $logDir "gateway.log"
$gwErr = Join-Path $logDir "gateway.err.log"
$portalLog = Join-Path $logDir "portal.log"
$portalErr = Join-Path $logDir "portal.err.log"

Write-Host "======================================" -ForegroundColor Cyan
Write-Host " 中国移动数智智能体平台 - 启动脚本" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan

Write-Host "`n0/5 Clean up stale processes..." -ForegroundColor Cyan
# Stale gateway/portal/dsh processes hold ports 8080/5173 and make the new
# stack fail silently. Kill every node/cmd/pnpm process whose command line
# references the repo folder (see stop.ps1), whole tree via taskkill /T.
$stale = Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='cmd.exe' OR Name='pnpm.cmd'" |
    Where-Object { $cl = $_.CommandLine; $cl -and $cl -like '*dsh-platform*' }
if ($stale) {
    foreach ($p in $stale) {
        cmd /c "taskkill /PID $($p.ProcessId) /T /F" 2>$null | Out-Null
    }
    Start-Sleep -Seconds 1
    Write-Host "Cleaned $($stale.Count) stale process(es)" -ForegroundColor Green
} else {
    Write-Host "No stale processes" -ForegroundColor Green
}

Write-Host "`n1/5 Check MySQL..." -ForegroundColor Cyan
$mysql = Get-Service -Name "MySQL" -ErrorAction SilentlyContinue
if ($mysql -and $mysql.Status -ne 'Running') {
    Start-Service -Name "MySQL"
    Start-Sleep -Seconds 3
}
Write-Host "MySQL OK" -ForegroundColor Green

Write-Host "`n2/5 Check Redis..." -ForegroundColor Cyan
if (-not (Get-Process -Name "redis-server" -ErrorAction SilentlyContinue)) {
    $redisCmd = (Get-Command redis-server -ErrorAction SilentlyContinue).Source
    if ($redisCmd) {
        Start-Process -FilePath $redisCmd
        Start-Sleep -Seconds 2
        Write-Host "Redis started" -ForegroundColor Green
    } else {
        Write-Host "redis-server not found; session store falls back to memory" -ForegroundColor Yellow
    }
} else {
    Write-Host "Redis OK" -ForegroundColor Green
}

Write-Host "`n3/5 Ensure directories..." -ForegroundColor Cyan
$envPath = Join-Path -Path $root -ChildPath ".env"
if (-not (Test-Path $envPath)) {
    Copy-Item (Join-Path $root ".env.example") $envPath
    Write-Host "Created .env from .env.example - please review settings" -ForegroundColor Yellow
}
$homesDir = Join-Path $root "var/homes"
$workspacesDir = Join-Path $root "var/workspaces"
if (-not (Test-Path $homesDir)) { New-Item -ItemType Directory -Path $homesDir -Force | Out-Null }
if (-not (Test-Path $workspacesDir)) { New-Item -ItemType Directory -Path $workspacesDir -Force | Out-Null }
Write-Host "var/homes + var/workspaces ready" -ForegroundColor Green

Write-Host "`n4/5 Build packages..." -ForegroundColor Cyan
pnpm --filter @dsh-platform/shared build
if ($LASTEXITCODE -ne 0) { Write-Host "shared build failed" -ForegroundColor Red; exit 1 }
Write-Host "Shared package built" -ForegroundColor Green

Write-Host "`n5/5 Start gateway + portal..." -ForegroundColor Cyan

# --- Gateway: capture output, poll port until ready ---
Remove-Item $gwLog, $gwErr -ErrorAction SilentlyContinue
$gwProc = Start-Process -FilePath "pnpm.cmd" `
    -ArgumentList "--filter", "@dsh-platform/gateway", "dev" `
    -WorkingDirectory $root -PassThru -NoNewWindow `
    -RedirectStandardOutput $gwLog -RedirectStandardError $gwErr

$gwReady = $false
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    if ($gwProc.HasExited) { break }
    try {
        $conn = Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue
        if ($conn) { $gwReady = $true; break }
    } catch { }
}

if (-not $gwReady) {
    Write-Host "`nGateway FAILED to listen on :8080" -ForegroundColor Red
    Write-Host "--- gateway.log ---" -ForegroundColor Yellow
    if (Test-Path $gwLog) { Get-Content $gwLog -Tail 40 }
    Write-Host "--- gateway.err.log ---" -ForegroundColor Yellow
    if (Test-Path $gwErr) { Get-Content $gwErr -Tail 40 }
    Write-Host "`nPortal not started. Fix the gateway error above and retry." -ForegroundColor Red
    exit 1
}
Write-Host "Gateway listening on :8080" -ForegroundColor Green

# --- Portal ---
Remove-Item $portalLog, $portalErr -ErrorAction SilentlyContinue
Start-Process -FilePath "pnpm.cmd" `
    -ArgumentList "--filter", "@dsh-platform/portal", "dev" `
    -WorkingDirectory $root -PassThru -NoNewWindow `
    -RedirectStandardOutput $portalLog -RedirectStandardError $portalErr | Out-Null

$portalReady = $false
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 1
    try {
        $conn = Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue
        if ($conn) { $portalReady = $true; break }
    } catch { }
}

Write-Host "`n======================================" -ForegroundColor Green
if ($portalReady) {
    Write-Host "All services started!" -ForegroundColor Green
} else {
    Write-Host "Gateway up, but portal may still be starting..." -ForegroundColor Yellow
}
Write-Host "  Platform Portal:   http://localhost:5173" -ForegroundColor Green
Write-Host "  Gateway API:       http://127.0.0.1:8080" -ForegroundColor Green
Write-Host "  Health check:      http://127.0.0.1:8080/api/health" -ForegroundColor Green
Write-Host "  Login:             admin@local.dev / Admin@12345" -ForegroundColor Green
Write-Host "  Logs:              $logDir" -ForegroundColor DarkGray
Write-Host "======================================" -ForegroundColor Green

try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:8080/api/health" -UseBasicParsing
    Write-Host "Health: $($r.Content)" -ForegroundColor Green
} catch { Write-Host "Warning: gateway health check failed" -ForegroundColor Yellow }