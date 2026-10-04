$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
$traceUrl = 'http://127.0.0.1:4318'
try {
    $existingTrace = Invoke-RestMethod "$traceUrl/api/health" -TimeoutSec 2
    if ($existingTrace.service -eq 'codex-trace') {
        Write-Output "CODEX TRACE is already running: $traceUrl/"
        return
    }
} catch { }
$nodePath = (Get-Command node -ErrorAction Stop).Source
$runtimeDir = Join-Path $taskRoot '.runtime'
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
$ownedServer = Start-Process -FilePath $nodePath -ArgumentList @('"' + (Join-Path $taskRoot 'scripts/server.mjs') + '"') -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeDir 'collector.log') -RedirectStandardError (Join-Path $runtimeDir 'collector.err.log') -PassThru
@{ pid = $ownedServer.Id; startedAt = $ownedServer.StartTime.ToUniversalTime().ToString('o'); script = (Join-Path $taskRoot 'scripts/server.mjs') } | ConvertTo-Json | Set-Content (Join-Path $runtimeDir 'collector-process.json') -Encoding utf8
for ($attempt = 0; $attempt -lt 20; $attempt++) {
    Start-Sleep -Milliseconds 500
    if ($ownedServer.HasExited) { throw 'Collector could not start. See .runtime/collector.err.log.' }
    try {
        $ready = Invoke-RestMethod "$traceUrl/api/health" -TimeoutSec 2
        if ($ready.service -eq 'codex-trace' -and $ready.pid -eq $ownedServer.Id) { Write-Output "CODEX TRACE running: $traceUrl/"; return }
    } catch { }
}
throw 'Collector is starting; readiness has not been verified.'
