param()
$ErrorActionPreference = 'Stop'
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$privateDir = Join-Path $repoRoot 'private\local-memory'
$stateFile = Join-Path $privateDir 'local-processes.json'
$statusFile = Join-Path $privateDir 'service-status.json'
$stopFile = Join-Path $privateDir 'service-stop.json'
if (!(Test-Path -LiteralPath $stateFile)) { Write-Output '{"stopped":true,"trackedProcesses":0}'; return }
$state = Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
function Get-OwnedProcess($record, [string]$expectedScript) {
    if (!$record) { return $null }
    if ($record.script -ne $expectedScript) { throw 'Unexpected saved script path; no process was changed.' }
    $process = Get-Process -Id $record.processId -ErrorAction SilentlyContinue
    if (!$process) { return $null }
    $info = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $record.processId)
    if ($process.StartTime.ToUniversalTime().Ticks -ne ([DateTime]$record.startTimeUtc).ToUniversalTime().Ticks -or
        !$info.CommandLine -or !$info.CommandLine.Contains($expectedScript)) {
        throw 'A saved process identity no longer matches. No unknown process was changed.'
    }
    return $process
}
$serviceScript = Join-Path $PSScriptRoot 'supervise.mjs'
$embeddingScript = Join-Path $PSScriptRoot 'local-embedding-server.mjs'
$consumerScript = Join-Path $PSScriptRoot 'local-memory-consumer.mjs'
# Validate all tracked identities before changing any process.
$service = Get-OwnedProcess $state.processes.service $serviceScript
$embedding = Get-OwnedProcess $state.processes.embedding $embeddingScript
$consumer = Get-OwnedProcess $state.processes.consumer $consumerScript
$workerRecord = $null
if ($service) {
    if (Test-Path -LiteralPath $statusFile) {
        $status = Get-Content -LiteralPath $statusFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($status.supervisorPid -eq $service.Id -and $status.pid) {
            $worker = Get-Process -Id $status.pid -ErrorAction SilentlyContinue
            $workerInfo = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $status.pid)
            $workerScript = Join-Path $repoRoot 'apps\service\main.ts'
            if ($worker -and $workerInfo.ParentProcessId -eq $service.Id -and $workerInfo.CommandLine.Contains($workerScript)) {
                $workerRecord = [ordered]@{ processId = $worker.Id; startTimeUtc = $worker.StartTime.ToUniversalTime().ToString('o'); script = $workerScript }
            }
        }
    }
    [System.IO.File]::WriteAllText($stopFile, '{"stop":true}', (New-Object System.Text.UTF8Encoding $false))
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        $remaining = Get-OwnedProcess $state.processes.service $serviceScript
        if ($remaining) { Start-Sleep -Milliseconds 250 }
    } while ($remaining -and [DateTime]::UtcNow -lt $deadline)
    if ($remaining) { Stop-Process -Id $remaining.Id }
    if ($workerRecord) {
        $workerRemaining = Get-OwnedProcess $workerRecord $workerRecord.script
        if ($workerRemaining) { Stop-Process -Id $workerRemaining.Id }
    }
    if ((Test-Path -LiteralPath $statusFile) -and !(Get-OwnedProcess $state.processes.service $serviceScript)) {
        $lastStatus = Get-Content -LiteralPath $statusFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($lastStatus.supervisorPid -eq $service.Id) {
            $lastStatus.state = 'stopped'
            $lastStatus.heartbeatAt = [DateTime]::UtcNow.ToString('o')
            [System.IO.File]::WriteAllText($statusFile, ($lastStatus | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding $false))
        }
    }
}
foreach ($role in @('consumer', 'embedding')) {
    $expected = if ($role -eq 'consumer') { $consumerScript } else { $embeddingScript }
    $record = $state.processes.PSObject.Properties[$role].Value
    $remaining = Get-OwnedProcess $record $expected
    if ($remaining) { Stop-Process -Id $remaining.Id }
}
[ordered]@{ stopped = $true; databaseKept = $true; dataKept = $true } | ConvertTo-Json -Compress
