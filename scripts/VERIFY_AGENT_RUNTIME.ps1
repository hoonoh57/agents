$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host '[verify-agent-runtime] validate workspace'
node .\scripts\agent_runtime.mjs validate
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$agentId = 'experiment-validation'
$statePath = Join-Path $root "agents\$agentId\STATE.json"
$backlogPath = Join-Path $root 'coordinator\BACKLOG.json'
$tempDir = Join-Path $root 'runtime\agent-runtime-smoke'
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
$stateBackup = Join-Path $tempDir 'STATE.json.bak'
$backlogBackup = Join-Path $tempDir 'BACKLOG.json.bak'
Copy-Item $statePath $stateBackup -Force
Copy-Item $backlogPath $backlogBackup -Force

$taskId = $null
$resultId = $null
try {
    Write-Host '[verify-agent-runtime] enqueue smoke task'
    $enqueueOutput = & node .\scripts\agent_runtime.mjs enqueue `
        --agent $agentId `
        --goal GOAL-RUNTIME-SMOKE `
        --objective 'Verify queue, lease, state transition, result persistence and completion semantics only.' `
        --priority 99 `
        --created-by SYSTEM_SMOKE 2>&1
    $enqueueOutput | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0) { throw 'enqueue failed' }
    $joined = ($enqueueOutput -join "`n")
    if ($joined -notmatch 'ENQUEUED\s+(TASK-[A-Za-z0-9-]+)') { throw 'could not parse smoke task id' }
    $taskId = $Matches[1]
    $resultId = 'RESULT-' + $taskId.Substring(5)

    Write-Host "[verify-agent-runtime] worker mock task=$taskId"
    node .\scripts\agent_runtime.mjs worker-once --mock
    if ($LASTEXITCODE -ne 0) { throw 'mock worker failed' }

    $resultPath = Join-Path $root "agents\$agentId\results\$resultId.json"
    $workPath = Join-Path $root "agents\$agentId\work\$taskId.json"
    $inboxPath = Join-Path $root "agents\$agentId\inbox\$taskId.json"
    if (-not (Test-Path $resultPath)) { throw "missing result $resultPath" }
    if (-not (Test-Path $workPath)) { throw "missing work snapshot $workPath" }
    if (Test-Path $inboxPath) { throw "completed task still present in inbox $inboxPath" }

    $result = Get-Content $resultPath -Raw | ConvertFrom-Json
    if ($result.schema -ne 'AgentResult@1.0.0') { throw 'invalid result schema' }
    if ($result.status -ne 'COMPLETED') { throw 'result not completed' }
    if ($result.taskId -ne $taskId) { throw 'result/task mismatch' }

    $state = Get-Content $statePath -Raw | ConvertFrom-Json
    if ($state.status -ne 'COMPLETED') { throw 'agent state not completed' }
    if ($state.lastCompletedTaskId -ne $taskId) { throw 'agent state lastCompletedTaskId mismatch' }

    $backlog = Get-Content $backlogPath -Raw | ConvertFrom-Json
    $item = $backlog.items | Where-Object { $_.taskId -eq $taskId } | Select-Object -First 1
    if (-not $item) { throw 'task missing from coordinator backlog' }
    if ($item.status -ne 'COMPLETED') { throw 'backlog task not completed' }
    if ($item.resultId -ne $resultId) { throw 'backlog resultId mismatch' }

    Write-Host '[verify-agent-runtime] PASS lifecycle QUEUED -> RUNNING -> COMPLETED'
}
finally {
    Copy-Item $stateBackup $statePath -Force
    Copy-Item $backlogBackup $backlogPath -Force
    if ($taskId) {
        Remove-Item (Join-Path $root "agents\$agentId\inbox\$taskId.json") -Force -ErrorAction SilentlyContinue
        Remove-Item (Join-Path $root "agents\$agentId\work\$taskId.json") -Force -ErrorAction SilentlyContinue
    }
    if ($resultId) {
        Remove-Item (Join-Path $root "agents\$agentId\results\$resultId.json") -Force -ErrorAction SilentlyContinue
    }
}

Write-Host '[verify-agent-runtime] validate restored workspace'
node .\scripts\agent_runtime.mjs validate
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$dirty = git status --porcelain
if ($dirty) {
    Write-Host '[verify-agent-runtime] FAIL working tree changed:'
    $dirty | ForEach-Object { Write-Host $_ }
    exit 1
}

Write-Host '[verify-agent-runtime] PASS no persistent research artifacts; working tree clean'
