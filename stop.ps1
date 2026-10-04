$ErrorActionPreference = 'Stop'
$ownerFile = Join-Path $PSScriptRoot '.runtime/collector-process.json'
if (-not (Test-Path -LiteralPath $ownerFile)) { Write-Output 'No owned collector recorded.'; return }
$record = Get-Content -LiteralPath $ownerFile -Raw | ConvertFrom-Json
$ownedProcess = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
if (-not $ownedProcess) { Write-Output 'Collector already stopped.'; return }
$actual = Get-CimInstance Win32_Process -Filter "ProcessId = $($record.pid)"
$recordedStart = ([datetime]$record.startedAt).ToUniversalTime()
if ($ownedProcess.StartTime.ToUniversalTime().Ticks -ne $recordedStart.Ticks -or $actual.CommandLine -notlike "*$($record.script)*") { throw 'Process identity differs. No process was stopped.' }
Stop-Process -Id $record.pid
Write-Output 'Owned CODEX TRACE collector stopped.'
