# Watchdog — keeps hub, both servers, and both Vite devs alive
$shalinRoot = "D:\het-desktop\shalin_bhaiya_funnel - Copy (2) - Copy"
$siddhuRoot = "D:\het-desktop\siddhu_bhaiya_api_zerodha_replica - Copy\siddhu_bhaiya_api_test_replica"

function PortListening($port) {
    $result = netstat -ano | Select-String ":$port\s"
    return ($result -match "LISTENING")
}

function StartHub {
    Write-Host "[watchdog] Starting HUB on :8765..."
    Start-Process -FilePath "node" -ArgumentList "ws-hub/index.cjs" -WorkingDirectory $shalinRoot -WindowStyle Hidden
    Start-Sleep -Seconds 3
}

function StartShalinServer {
    Write-Host "[watchdog] Starting Shalin server on :3000..."
    Start-Process -FilePath "node" -ArgumentList "--env-file=.env", "server/index.js" -WorkingDirectory $shalinRoot -WindowStyle Hidden
    Start-Sleep -Seconds 2
}

function StartSiddhuServer {
    Write-Host "[watchdog] Starting Siddhu server on :3001..."
    Start-Process -FilePath "node" -ArgumentList "--env-file=.env", "server/index.js" -WorkingDirectory $siddhuRoot -WindowStyle Hidden
    Start-Sleep -Seconds 2
}

function StartShalinVite {
    Write-Host "[watchdog] Starting Shalin Vite on :5292..."
    Start-Process -FilePath "npx" -ArgumentList "vite" -WorkingDirectory $shalinRoot -WindowStyle Hidden
    Start-Sleep -Seconds 4
}

function StartSiddhuVite {
    Write-Host "[watchdog] Starting Siddhu Vite on :5191..."
    Start-Process -FilePath "npx" -ArgumentList "vite" -WorkingDirectory $siddhuRoot -WindowStyle Hidden
    Start-Sleep -Seconds 4
}

Write-Host "[watchdog] Started — checking every 20s"
Write-Host "[watchdog] Shalin: http://192.168.90.106:5292"
Write-Host "[watchdog] Siddhu: http://192.168.90.106:5191"

while ($true) {
    if (-not (PortListening 8765))  { StartHub }
    if (-not (PortListening 3000))  { StartShalinServer }
    if (-not (PortListening 3001))  { StartSiddhuServer }
    if (-not (PortListening 5292))  { StartShalinVite }
    if (-not (PortListening 5191))  { StartSiddhuVite }

    $ts = Get-Date -Format "HH:mm:ss"
    Write-Host "[$ts] hub:8765 server:3000/3001 vite:5292/5191 — all OK"
    Start-Sleep -Seconds 20
}
