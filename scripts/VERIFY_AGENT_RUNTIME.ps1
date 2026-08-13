$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$agentId = 'experiment-validation'
$smokeGoalId = 'GOAL-RUNTIME-SMOKE'
$smokeCreatedBy = 'SYSTEM_SMOKE'
$agentRoot = Join-Path $root "agents\$agentId"
$inboxDir = Join-Path $agentRoot 'inbox'
$workDir = Join-Path $agentRoot 'work'
$resultDir = Join-Path $agentRoot 'results'
$statePath = Join-Path $agentRoot 'STATE.json'
$backlogPath = Join-Path $root 'coordinator\BACKLOG.json'
$tempDir = Join-Path $root 'runtime\agent-runtime-smoke'
$quarantineDir = Join-Path $tempDir 'inbox-quarantine'
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
New-Item -ItemType Directory -Path $quarantineDir -Force | Out-Null

function Read-JsonSafe([string]$Path) {
    try {
        return Get-Content $Path -Raw | ConvertFrom-Json
    }
    catch {
        return $null
    }
}

function Remove-StaleSmokeArtifacts {
    $smokeTaskIds = New-Object System.Collections.Generic.HashSet[string]

    foreach ($dir in @($inboxDir, $workDir)) {
        if (-not (Test-Path $dir)) { continue }
        Get-ChildItem $dir -Filter '*.json' -File -ErrorAction SilentlyContinue | ForEach-Object {
            $doc = Read-JsonSafe $_.FullName
            if ($null -eq $doc) { return }
            if ($doc.goalId -eq $smokeGoalId -or $doc.createdBy -eq $smokeCreatedBy) {
                if ($doc.taskId) { [void]$smokeTaskIds.Add([string]$doc.taskId) }
            }
        }
    }

    if ($smokeTaskIds.Count -eq 0) { return }

    Write-Host "[verify-agent-runtime] cleanup stale smoke artifacts count=$($smokeTaskIds.Count)"
    foreach ($task in $smokeTaskIds) {
        Remove-Item (Join-Path $inboxDir "$task.json") -Force -ErrorAction SilentlyContinue
        Remove-Item (Join-Path $workDir "$task.json") -Force -ErrorAction SilentlyContinue
        if ($task.StartsWith('TASK-')) {
            $rid = 'RESULT-' + $task.Substring(5)
            Remove-Item (Join-Path $resultDir "$rid.json") -Force -ErrorAction SilentlyContinue
        }
    }
}

function Quarantine-OtherInboxTasks([string]$KeepTaskId) {
    $moved = @()
    Get-ChildItem $inboxDir -Filter '*.json' -File -ErrorAction SilentlyContinue | ForEach-Object {
        if ($_.BaseName -eq $KeepTaskId) { return }
        $dest = Join-Path $quarantineDir $_.Name
        Move-Item $_.FullName $dest -Force
        $moved += $dest
    }
    return ,$moved
}

function Restore-QuarantinedInboxTasks([object[]]$Moved) {
    foreach ($file in @($Moved)) {
        if ($file -and (Test-Path $file)) {
            Move-Item $file (Join-Path $inboxDir (Split-Path $file -Leaf)) -Force
        }
    }
}

Remove-StaleSmokeArtifacts

Write-Host '[verify-agent-runtime] validate workspace'
node .\scripts\agent_runtime_stable.mjs validate
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$stateBackup = Join-Path $tempDir 'STATE.json.bak'
$backlogBackup = Join-Path $tempDir 'BACKLOG.json.bak'
Copy-Item $statePath $stateBackup -Force
Copy-Item $backlogPath $backlogBackup -Force

$taskId = $null
$resultId = $null
$quarantined = @()
try {
    Write-Host '[verify-agent-runtime] enqueue smoke task'
    $enqueueOutput = & node .\scripts\agent_runtime_stable.mjs enqueue `
        --agent $agentId `
        --goal $smokeGoalId `
        --objective 'Verify queue, lease, state transition, result persistence and completion semantics only.' `
        --priority 99 `
        --created-by $smokeCreatedBy 2>&1
    $enqueueOutput | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0) { throw 'enqueue failed' }
    $joined = ($enqueueOutput -join "`n")
    if ($joined -notmatch 'ENQUEUED\s+(TASK-[A-Za-z0-9-]+)') { throw 'could not parse smoke task id' }
    $taskId = $Matches[1]
    $resultId = 'RESULT-' + $taskId.Substring(5)

    $quarantined = @(Quarantine-OtherInboxTasks -KeepTaskId $taskId)
    if ($quarantined.Count -gt 0) {
        Write-Host "[verify-agent-runtime] isolated smoke task; preserved other inbox tasks=$($quarantined.Count)"
    }

    Write-Host "[verify-agent-runtime] worker mock task=$taskId"
    node .\scripts\agent_runtime_stable.mjs worker-once --mock
    if ($LASTEXITCODE -ne 0) { throw 'mock worker failed' }

    $resultPath = Join-Path $resultDir "$resultId.json"
    $workPath = Join-Path $workDir "$taskId.json"
    $inboxPath = Join-Path $inboxDir "$taskId.json"
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
        Remove-Item (Join-Path $inboxDir "$taskId.json") -Force -ErrorAction SilentlyContinue
        Remove-Item (Join-Path $workDir "$taskId.json") -Force -ErrorAction SilentlyContinue
    }
    if ($resultId) {
        Remove-Item (Join-Path $resultDir "$resultId.json") -Force -ErrorAction SilentlyContinue
    }
    Restore-QuarantinedInboxTasks -Moved $quarantined
}

Write-Host '[verify-agent-runtime] validate restored workspace'
node .\scripts\agent_runtime_stable.mjs validate
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$dirty = git status --porcelain
if ($dirty) {
    Write-Host '[verify-agent-runtime] FAIL working tree changed:'
    $dirty | ForEach-Object { Write-Host $_ }
    exit 1
}

Write-Host '[verify-agent-runtime] PASS no persistent research artifacts; working tree clean'
