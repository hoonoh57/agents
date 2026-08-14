[CmdletBinding()]
param(
    [string]$ResearchRoot = 'E:\2026\opus\typescript\kiwoom-autotrade-template',
    [switch]$TestNow,
    [switch]$ForceNew
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $Root
$Template = 'autonomous-ma-period-search.json'
$GoalId = 'GOAL-AUTONOMOUS-MA-PERIOD-SEARCH-001'
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
    $a = $r.autonomousResearch
    if (-not $a -or $a.schema -ne 'AutonomousResearchTaskEvidence@1.0.0') { return $false }
    if ($a.finalTurn.status -ne 'COMPLETE' -or $a.profitabilityClaim -ne $false) { return $false }
    if ([int]$r.runtimeMetrics.keepAlive -ne 0) { return $false }

    $action = $a.firstTurn.actions[0]
    if ([string]$action.tool -ne 'RUN_FEATURE_PERIOD_SEARCH') { return $false }
    if ([string]$action.arguments.featureId -ne 'PRICE_MA_RECLAIM_UP') { return $false }
    if ([int]$action.arguments.parameters.periodMin -ne 5 -or [int]$action.arguments.parameters.periodMax -ne 120 -or [int]$action.arguments.parameters.periodStep -ne 5) { return $false }

    $e = $a.toolEvidence.evidence
    if ([string]$e.tool -ne 'RUN_FEATURE_PERIOD_SEARCH') { return $false }
    if ($e.method.discoveryOnlyRanking -ne $true -or $e.method.selectedCandidateFrozenBeforeValidation -ne $true -or $e.method.nonSelectedValidationEvaluated -ne $false) { return $false }
    $validationPeriods = @($e.method.validationEvaluatedPeriods)
    if ($validationPeriods.Count -gt 1) { return $false }
    if ($e.selectedCandidate) {
        if ($validationPeriods.Count -ne 1 -or [int]$validationPeriods[0] -ne [int]$e.selectedCandidate.period) { return $false }
    } elseif ($validationPeriods.Count -ne 0) { return $false }

    $completion = $a.semanticCompletionDecision
    if ([string]$completion.featureId -ne 'PRICE_MA_RECLAIM_UP') { return $false }
    if ([string]$completion.searchStatus -ne [string]$e.status) { return $false }
    if ([int]$completion.candidateCount -ne @($e.discoveryRanking).Count) { return $false }
    if ([int]$completion.validationSampleCount -ne [int]$e.validation.sampleCount) { return $false }
    if ($e.selectedCandidate) {
        if ([int]$completion.selectedPeriod -ne [int]$e.selectedCandidate.period) { return $false }
        if ([int]$completion.discoverySampleCount -ne [int]$e.selectedCandidate.discovery.sampleCount) { return $false }
    }
    $runtimeEvidenceId = [string]$a.toolEvidence.evidenceId
    if ([string]$a.finalTurn.evidenceRefs[0] -ne $runtimeEvidenceId) { return $false }

    $selected = if ($e.selectedCandidate) { [string]$e.selectedCandidate.period } else { 'none' }
    Write-Host "[ma-period-search] PASS task=$TaskId result=$($r.resultId) status=$($e.status) selectedPeriod=$selected candidates=$(@($e.discoveryRanking).Count) discovery=$($e.selectedCandidate.discovery.sampleCount) validation=$($e.validation.sampleCount) keepAlive=$($r.runtimeMetrics.keepAlive)"
    return $true
}

Write-Host '[ma-period-search] pull agents'
Invoke-NativeChecked 'agents pull' { git pull --ff-only origin main } | Out-Null

if (-not (Test-Path (Join-Path $ResearchRoot '.git'))) { throw "research repository not found: $ResearchRoot" }
Write-Host '[ma-period-search] pull trading research repo'
Invoke-NativeChecked 'research pull' { git -C $ResearchRoot pull --ff-only origin main } | Out-Null
$env:RESEARCH_LOCAL_ROOT = $ResearchRoot

Write-Host '[ma-period-search] verify deterministic search tool and production router'
Invoke-NativeChecked 'search tool parse' { node --check (Join-Path $ResearchRoot 'scripts\run_feature_period_search_tool.mjs') } | Out-Null
Invoke-NativeChecked 'search tool self-test' { node (Join-Path $ResearchRoot 'scripts\run_feature_period_search_tool.mjs') --self-test } | Out-Null
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
        Write-Host "[ma-period-search] resume queued task=$taskId"
    } elseif ($status -in @('ERROR','BLOCKED')) {
        if (-not (Test-Path $inboxPath)) { throw "failed task has no inbox snapshot: $taskId; use -ForceNew only for a deliberate new lineage" }
        Write-Host "[ma-period-search] RETRY_SAME_LINEAGE task=$taskId previousStatus=$status"
    } else {
        throw "existing MA period search has unsupported status=$status task=$taskId"
    }
} else {
    Write-Host '[ma-period-search] enqueue autonomous period search'
    $out = Invoke-NativeChecked 'enqueue autonomous task' { node .\scripts\agent_worker_router.mjs enqueue --template $Template }
    $joined = ($out -join "`n")
    if ($joined -notmatch 'ENQUEUED\s+(TASK-[A-Za-z0-9-]+)') { throw 'could not parse autonomous task id' }
    $taskId = $Matches[1]

    Write-Host "[ma-period-search] persist queued task=$taskId"
    git add -- agents/experiment-validation coordinator
    if ($LASTEXITCODE -ne 0) { throw 'git add queued task failed' }
    git commit -m 'Queue autonomous MA period search'
    if ($LASTEXITCODE -ne 0) { throw 'git commit queued task failed' }
    git push origin main
    if ($LASTEXITCODE -ne 0) { throw 'git push queued task failed' }
}

Write-Host "[ma-period-search] execute production one-shot worker task=$taskId testNow=$($TestNow.IsPresent)"
if ($TestNow) {
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\RUN_RESEARCH_WINDOW_ONCE.ps1 -TestNow
} else {
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\RUN_RESEARCH_WINDOW_ONCE.ps1
}
if ($LASTEXITCODE -ne 0) { throw "research-window worker failed exit=$LASTEXITCODE" }

$backlog = Get-Content $backlogPath -Raw -Encoding UTF8 | ConvertFrom-Json
$item = @($backlog.items | Where-Object { $_.taskId -eq $taskId } | Select-Object -First 1)
if ($item.Count -ne 1) { throw "autonomous MA period search task disappeared task=$taskId" }
if ($item[0].status -eq 'QUEUED' -and -not $TestNow) {
    Write-Host "[ma-period-search] QUEUED_WAITING_FOR_RESEARCH_WINDOW task=$taskId"
    exit 0
}
if ($item[0].status -ne 'COMPLETED') {
    throw "autonomous MA period search did not complete task=$taskId status=$($item[0].status)"
}
if (-not (Test-CompletedResult $taskId)) { throw "autonomous MA period search result contract failed task=$taskId" }
Write-Host "[ma-period-search] COMPLETE task=$taskId"
