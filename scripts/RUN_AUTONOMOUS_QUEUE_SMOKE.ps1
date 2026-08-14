[CmdletBinding()]
param(
    [string]$ResearchRoot = 'E:\2026\opus\typescript\kiwoom-autotrade-template',
    [switch]$ForceNew
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $Root
$Template = 'autonomous-ma5-queue-smoke.json'
$GoalId = 'GOAL-AUTONOMOUS-MA5-SMOKE-001'
$AgentId = 'experiment-validation'

function Invoke-NativeChecked {
    param([string]$Step, [scriptblock]$Command)
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $lines = @(& $Command 2>&1)
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $saved }
    $lines | ForEach-Object { Write-Host $_ }
    if ($code -ne 0) { throw "$Step failed exit=$code" }
    return $lines
}

function Get-ResultPath([string]$TaskId) {
    $rid = 'RESULT-' + $TaskId.Substring(5)
    return Join-Path $Root "agents\$AgentId\results\$rid.json"
}

function Test-CompletedResult([string]$TaskId) {
    $path = Get-ResultPath $TaskId
    if (-not (Test-Path $path)) { return $false }
    $r = Get-Content $path -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($r.schema -ne 'AgentResult@1.0.0' -or $r.status -ne 'COMPLETED' -or $r.executionMode -ne 'AUTONOMOUS_RESEARCH') { return $false }
    if (-not $r.autonomousResearch -or $r.autonomousResearch.schema -ne 'AutonomousResearchTaskEvidence@1.0.0') { return $false }
    if ($r.autonomousResearch.finalTurn.status -ne 'COMPLETE') { return $false }
    if ($r.autonomousResearch.profitabilityClaim -ne $false) { return $false }
    if ([int]$r.runtimeMetrics.keepAlive -ne 0) { return $false }
    $events = [int]$r.autonomousResearch.toolEvidence.evidence.eventCount
    $discovery = [int]$r.autonomousResearch.toolEvidence.evidence.discovery.sampleCount
    $validation = [int]$r.autonomousResearch.toolEvidence.evidence.validation.sampleCount
    $period = [int]$r.autonomousResearch.firstTurn.actions[0].arguments.parameters.period
    $feature = [string]$r.autonomousResearch.firstTurn.actions[0].arguments.featureId
    $completion = $r.autonomousResearch.semanticCompletionDecision
    if ([string]$completion.observedFeatureId -ne $feature) { return $false }
    if ([int]$completion.observedPeriod -ne $period) { return $false }
    if ([int]$completion.observedEventCount -ne $events) { return $false }
    if ([int]$completion.observedDiscoverySampleCount -ne $discovery) { return $false }
    if ([int]$completion.observedValidationSampleCount -ne $validation) { return $false }
    $runtimeEvidenceId = [string]$r.autonomousResearch.toolEvidence.evidenceId
    if ([string]$r.autonomousResearch.finalTurn.evidenceRefs[0] -ne $runtimeEvidenceId) { return $false }
    Write-Host "[queue-smoke] PASS existing task=$TaskId result=$($r.resultId) feature=$feature period=$period events=$events discovery=$discovery validation=$validation keepAlive=$($r.runtimeMetrics.keepAlive)"
    return $true
}

Write-Host '[queue-smoke] pull agents'
Invoke-NativeChecked 'agents pull' { git pull --ff-only origin main } | Out-Null

if (-not (Test-Path (Join-Path $ResearchRoot '.git'))) { throw "research repository not found: $ResearchRoot" }
$env:RESEARCH_LOCAL_ROOT = $ResearchRoot

Write-Host '[queue-smoke] verify router and autonomous engine'
Invoke-NativeChecked 'router parse' { node --check .\scripts\agent_worker_router.mjs } | Out-Null
Invoke-NativeChecked 'engine parse' { node --check .\scripts\autonomous_research_engine.mjs } | Out-Null
Invoke-NativeChecked 'router self-test' { node .\scripts\agent_worker_router.mjs self-test } | Out-Null

$backlogPath = Join-Path $Root 'coordinator\BACKLOG.json'
$backlog = Get-Content $backlogPath -Raw -Encoding UTF8 | ConvertFrom-Json
$existing = @($backlog.items | Where-Object { $_.goalId -eq $GoalId -and $_.executionMode -eq 'AUTONOMOUS_RESEARCH' } | Select-Object -Last 1)
if ($existing.Count -eq 1 -and -not $ForceNew) {
    $taskId = [string]$existing[0].taskId
    $status = [string]$existing[0].status
    $inboxPath = Join-Path $Root "agents\$AgentId\inbox\$taskId.json"
    if ($status -eq 'COMPLETED' -and (Test-CompletedResult $taskId)) { exit 0 }
    if ($status -eq 'RUNNING') { throw "task is already RUNNING: $taskId" }
    if ($status -eq 'QUEUED') {
        Write-Host "[queue-smoke] resume queued task=$taskId"
    } elseif ($status -in @('ERROR','BLOCKED')) {
        if (-not (Test-Path $inboxPath)) { throw "failed task has no inbox snapshot: $taskId; use -ForceNew only for a deliberate new lineage" }
        Write-Host "[queue-smoke] RETRY_SAME_LINEAGE task=$taskId previousStatus=$status"
    } else {
        throw "existing autonomous queue smoke has unsupported status=$status task=$taskId"
    }
} else {
    Write-Host '[queue-smoke] enqueue autonomous research task'
    $out = Invoke-NativeChecked 'enqueue autonomous task' { node .\scripts\agent_worker_router.mjs enqueue --template $Template }
    $joined = ($out -join "`n")
    if ($joined -notmatch 'ENQUEUED\s+(TASK-[A-Za-z0-9-]+)') { throw 'could not parse autonomous task id' }
    $taskId = $Matches[1]

    Write-Host "[queue-smoke] persist queued task=$taskId"
    git add -- agents/experiment-validation coordinator
    if ($LASTEXITCODE -ne 0) { throw 'git add queued task failed' }
    git commit -m 'Queue autonomous research worker smoke'
    if ($LASTEXITCODE -ne 0) { throw 'git commit queued task failed' }
    git push origin main
    if ($LASTEXITCODE -ne 0) { throw 'git push queued task failed' }
}

Write-Host "[queue-smoke] execute production one-shot worker task=$taskId with explicit daytime test override"
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\RUN_RESEARCH_WINDOW_ONCE.ps1 -TestNow
if ($LASTEXITCODE -ne 0) { throw "research-window worker failed exit=$LASTEXITCODE" }

$backlog = Get-Content $backlogPath -Raw -Encoding UTF8 | ConvertFrom-Json
$item = @($backlog.items | Where-Object { $_.taskId -eq $taskId } | Select-Object -First 1)
if ($item.Count -ne 1 -or $item[0].status -ne 'COMPLETED') {
    throw "autonomous queue task did not complete task=$taskId status=$($item[0].status)"
}
if (-not (Test-CompletedResult $taskId)) { throw "autonomous queue result contract failed task=$taskId" }

$changes = @(git status --porcelain -- agents coordinator)
if ($changes.Count -gt 0) {
    Write-Host '[queue-smoke] persist completion evidence'
    git add -- agents/experiment-validation coordinator
    if ($LASTEXITCODE -ne 0) { throw 'git add completion failed' }
    git commit -m 'Record autonomous queue smoke evidence'
    if ($LASTEXITCODE -ne 0) { throw 'git commit completion failed' }
    git push origin main
    if ($LASTEXITCODE -ne 0) { throw 'git push completion failed' }
}

Write-Host "[queue-smoke] COMPLETE task=$taskId"
