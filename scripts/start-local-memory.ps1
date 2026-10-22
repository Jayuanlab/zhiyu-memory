param()
$ErrorActionPreference = 'Stop'
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$privateDir = Join-Path $repoRoot 'private\local-memory'
$configFile = Join-Path $privateDir 'service.json'
$stateFile = Join-Path $privateDir 'local-processes.json'
$statusFile = Join-Path $privateDir 'service-status.json'
$stopFile = Join-Path $privateDir 'service-stop.json'
if (!(Test-Path -LiteralPath $configFile)) { throw 'Run the local setup before starting services.' }
$config = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
$node = (Get-Command node -ErrorAction Stop).Source
$state = [ordered]@{ schemaVersion = 1; processes = @{} }
if (Test-Path -LiteralPath $stateFile) {
    $saved = Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($item in $saved.processes.PSObject.Properties) { $state.processes[$item.Name] = $item.Value }
}
function Save-State {
    $state.updatedAt = [DateTime]::UtcNow.ToString('o')
    [System.IO.File]::WriteAllText($stateFile, ($state | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding $false))
}
function Get-OwnedProcess($record) {
    if (!$record) { return $null }
    $process = Get-Process -Id $record.processId -ErrorAction SilentlyContinue
    if (!$process) { return $null }
    $info = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $record.processId)
    if ($process.StartTime.ToUniversalTime().Ticks -ne ([DateTime]$record.startTimeUtc).ToUniversalTime().Ticks -or
        !$info.CommandLine -or !$info.CommandLine.Contains([string]$record.script)) {
        throw 'A saved process identity no longer matches. No unknown process was changed.'
    }
    return $process
}
function Assert-PortFree([int]$port) {
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
    if ($listeners.Count -gt 0) { throw "Port $port is occupied by an untracked process; it was left unchanged." }
}
function Start-Managed([string]$role, [string]$script, [string[]]$extraArgs, [int]$port) {
    if ($state.processes[$role] -and $state.processes[$role].script -ne $script) {
        throw 'Unexpected saved script path; no process was changed.'
    }
    $existing = Get-OwnedProcess $state.processes[$role]
    if ($existing) { return $existing }
    Assert-PortFree $port
    if ($role -eq 'service' -and (Test-Path -LiteralPath $stopFile)) {
        $previous = $state.processes[$role]
        $lastStatus = if (Test-Path -LiteralPath $statusFile) { Get-Content -LiteralPath $statusFile -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
        if (!$previous -or !$lastStatus -or $lastStatus.supervisorPid -ne $previous.processId -or $lastStatus.state -ne 'stopped') {
            throw 'An unowned or unresolved service stop marker exists; no marker was removed.'
        }
        Remove-Item -LiteralPath $stopFile
    }
    $arguments = @()
    if ($role -eq 'embedding') { $arguments += '--use-env-proxy' }
    $arguments += '"' + $script + '"'
    foreach ($argument in $extraArgs) { $arguments += '"' + $argument + '"' }
    $process = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $privateDir ($role + '.stdout.log')) `
        -RedirectStandardError (Join-Path $privateDir ($role + '.stderr.log'))
    $process.Refresh()
    $state.processes[$role] = [ordered]@{
        processId = $process.Id
        startTimeUtc = $process.StartTime.ToUniversalTime().ToString('o')
        script = $script
        port = $port
    }
    Save-State
    return $process
}
function Wait-Health([string]$url, [string]$role, [int]$seconds, [scriptblock]$validate) {
    $deadline = [DateTime]::UtcNow.AddSeconds($seconds)
    do {
        if (!(Get-OwnedProcess $state.processes[$role])) { throw "The $role process exited; inspect its private log files." }
        try {
            $response = Invoke-RestMethod -Uri $url -TimeoutSec 3
            if (& $validate $response) { return }
        } catch {}
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "The $role process did not become ready; inspect its private log files."
}

$embeddingPort = 11434
if ($config.env.MEMORY_EMBEDDING_URL) { $embeddingPort = ([Uri]$config.env.MEMORY_EMBEDDING_URL).Port }
if ($embeddingPort -ne 11434) { throw 'This local profile must use embedding port 11434.' }
$consumerPort = 3643
if ($config.env.MEMORY_SERVICE_CONSUMER_URL) { $consumerPort = ([Uri]$config.env.MEMORY_SERVICE_CONSUMER_URL).Port }
$servicePort = [int]$config.env.MEMORY_SERVICE_PORT
if ($servicePort -lt 1 -or $servicePort -gt 65535) { throw 'The configured memory service port is invalid.' }
$null = Start-Managed 'embedding' (Join-Path $PSScriptRoot 'local-embedding-server.mjs') @() $embeddingPort
Wait-Health "http://127.0.0.1:$embeddingPort/health" 'embedding' 120 { param($response) $response.ready -eq $true -and $response.local -eq $true -and $response.dimensions -eq 384 }
$null = Start-Managed 'consumer' (Join-Path $PSScriptRoot 'local-memory-consumer.mjs') @([string]$consumerPort) $consumerPort
Wait-Health "http://127.0.0.1:$consumerPort/health" 'consumer' 15 { param($response) $response.ready -eq $true -and $response.service -eq 'zhiyu-local-test-consumer' }
$null = Start-Managed 'service' (Join-Path $PSScriptRoot 'supervise.mjs') @($configFile) $servicePort
$deadline = [DateTime]::UtcNow.AddSeconds(45)
$ready = $false
do {
    if (!(Get-OwnedProcess $state.processes['service'])) { throw 'The memory supervisor exited; inspect private service logs.' }
    if (Test-Path -LiteralPath $statusFile) {
        try {
            $status = Get-Content -LiteralPath $statusFile -Raw -Encoding UTF8 | ConvertFrom-Json
            $ready = $status.supervisorPid -eq $state.processes['service'].processId -and $status.state -eq 'ready' -and $status.port -eq $servicePort
        } catch {}
    }
    if (!$ready) { Start-Sleep -Milliseconds 500 }
} while (!$ready -and [DateTime]::UtcNow -lt $deadline)
if (!$ready) { throw 'The memory service did not become ready; inspect private service logs.' }
[ordered]@{ ready = $true; origin = "http://127.0.0.1:$servicePort"; embeddingPort = $embeddingPort; consumerPort = $consumerPort } | ConvertTo-Json -Compress
