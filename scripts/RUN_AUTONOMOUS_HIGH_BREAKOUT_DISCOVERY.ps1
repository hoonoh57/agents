[CmdletBinding()]
param(
    [string]$ResearchRoot = 'E:\2026\opus\typescript\kiwoom-autotrade-template',
    [switch]$TestNow,
    [switch]$ForceNew
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $Root
$Template = 'autonomous-high-breakout-discovery.json'
$GoalId = 'GOAL-AUTONOMOUS-HIGH-BREAKOUT-DISCOVERY-001'
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
    if ([int]$r.runtimeMetrics.keepAlive -ne 0) { return $false }
    $a = $r.autonomousResearch
    if (-not $a -or $a.schema -ne 'AutonomousResearchTaskEvidence@1.0.0' -or $a.profitabilityClaim -ne $false) { return $false }
    if ($a.finalTurn.status -ne 'COMPLETE' -or $a.finalTurn.profitabilityClaim -ne $false) { return $false }

    $action = $a.firstTurn.actions[0]
    if ([string]$action.tool -ne 'RUN_HIGH_BREAKOUT_DISCOVERY_SEARCH') { return $false }
    if ([string]$action.arguments.featureId -ne 'PRICE_N_HIGH_BREAKOUT') { return $false }
    if ([int]$action.arguments.parameters.lookbackMin -ne 5 -or [int]$action.arguments.parameters.lookbackMax -ne 120 -or [int]$action.arguments.parameters.lookbackStep -ne 5) { return $false }

    $e = $a.toolEvidence.evidence
    if ([string]$e.tool -ne 'RUN_HIGH_BREAKOUT_DISCOVERY_SEARCH' -or [string]$e.featureId -ne 'PRICE_N_HIGH_BREAKOUT') { return $false }
    if ($e.method.discoveryOnlyRanking -ne $true -or $e.method.validationEvaluated -ne $false -or $e.method.historicalValidationReuseAllowed -ne $false) { return $false }
    if ($e.freshValidation.evaluated -ne $false) { return $false }
    if ([string]$e.method.freshValidationRequiresDecisionDateAfter -ne [string]$e.dateTo) { return $false }

    $completion = $a.semanticCompletionDecision
    if ([string]$completion.featureId -ne 'PRICE_N_HIGH_BREAKOUT') { return $false }
    if ([string]$completion.searchStatus -ne [string]$e.status) { return $false }
    if ([int]$completion.candidateCount -ne @($e.discoveryRanking).Count) { return $false }
    if ([string]$completion.freshValidationStatus -ne [string]$e.freshValidation.status) { return $false }

    if ($e.selectedCandidate) {
        if ([string]$e.status -ne 'WAITING_FOR_FRESH_VALIDATION') { return $false }
        if ([string]$e.freshValidation.status -ne 'WAITING_FOR_FRESH_VALIDATION') { return $false }
        if ($e.method.selectedCandidateFrozenBeforeFreshValidation -ne $true) { return $false }
        if ([string]$e.selectedCandidate.frozenAtDataCutoff -ne [string]$e.dateTo) { return $false }
        if ([int]$completion.selectedLookback -ne [int]$e.selectedCandidate.lookback) { return $false }
        if ([int]$completion.discoverySampleCount -ne [int]$e.selectedCandidate.discovery.sampleCount) { return $false }
    } else {
        if ([string]$e.status -notin @('NO_GO_DISCOVERY','NO_GO_NO_DISCOVERY_EVENTS')) { return $false }
        if ([string]$e.freshValidation.status -ne 'NOT_ELIGIBLE') { return $false }
    }

    $runtimeEvidenceId = [string]$a.toolEvidence.evidenceId
    if ([string]$a.finalTurn.evidenceRefs[0] -ne $runtimeEvidenceId) { return $false }

    $selected = if ($e.selectedCandidate) { [string]$e.selectedCandidate.lookback } else { 'none' }
    $discovery = if ($e.selectedCandidate) { [string]$e.selectedCandidate.discovery.sampleCount } elseif (@($e.discoveryRanking).Count -gt 0) { [string]$e.discoveryRanking[0].discovery.sampleCount } else { '0' }
    Write-Host "[high-breakout-discovery] PASS task=$TaskId result=$($r.resultId) status=$($e.status) selectedLookback=$selected candidates=$(@($e.discoveryRanking).Count) discovery=$discovery freshValidation=$($e.freshValidation.status) cutoff=$($e.dateTo) keepAlive=$($r.runtimeMetrics.keepAlive)"
    return $true
}

Write-Host '[high-breakout-discovery] pull agents'
Invoke-NativeChecked 'agents pull' { git pull --ff-only origin main } | Out-Null

if (-not (Test-Path (Join-Path $ResearchRoot '.git'))) { throw "research repository not found: $ResearchRoot" }
Write-Host '[high-breakout-discovery] pull trading research repo'
Invoke-NativeChecked 'research pull' { git -C $ResearchRoot pull --ff-only origin main } | Out-Null
$env:RESEARCH_LOCAL_ROOT = $ResearchRoot

Write-Host '[high-breakout-discovery] verify deterministic discovery tool and production router'
Invoke-NativeChecked 'discovery tool parse' { node --check (Join-Path $ResearchRoot 'scripts\run_high_breakout_discovery_tool.mjs') } | Out-Null
Invoke-NativeChecked 'discovery tool self-test' { node (Join-Path $ResearchRoot 'scripts\run_high_breakout_discovery_tool.mjs') --self-test } | Out-Null
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
        Write-Host "[high-breakout-discovery] resume queued task=$taskId"
    } elseif ($status -in @('ERROR','BLOCKED')) {
        if (-not (Test-Path $inboxPath)) { throw "failed task has no inbox snapshot: $taskId; use -ForceNew only for a deliberate new lineage" }
        Write-Host "[high-breakout-discovery] RETRY_SAME_LINEAGE task=$taskId previousStatus=$status"
    } else {
        throw "existing high-breakout discovery has unsupported status=$status task=$taskId"
    }
} else {
    Write-Host '[high-breakout-discovery] enqueue autonomous discovery search'
    $out = Invoke-NativeChecked 'enqueue autonomous task' { node .\scripts\agent_worker_router.mjs enqueue --template $Template }
    $joined = ($out -join "`n")
    if ($joined -notmatch 'ENQUEUED\s+(TASK-[A-Za-z0-9-]+)') { throw 'could not parse autonomous task id' }
    $taskId = $Matches[1]

    Write-Host "[high-breakout-discovery] persist queued task=$taskId"
    git add -- agents/experiment-validation coordinator
    if ($LASTEXITCODE -ne 0) { throw 'git add queued task failed' }
    git commit -m 'Queue autonomous high breakout discovery'
    if ($LASTEXITCODE -ne 0) { throw 'git commit queued task failed' }
    git push origin main
    if ($LASTEXITCODE -ne 0) { throw 'git push queued task failed' }
}

Write-Host "[high-breakout-discovery] execute production one-shot worker task=$taskId testNow=$($TestNow.IsPresent)"
if ($TestNow) {
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\RUN_RESEARCH_WINDOW_ONCE.ps1 -TestNow
} else {
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\RUN_RESEARCH_WINDOW_ONCE.ps1
}
if ($LASTEXITCODE -ne 0) { throw "research-window worker failed exit=$LASTEXITCODE" }

$backlog = Get-Content $backlogPath -Raw -Encoding UTF8 | ConvertFrom-Json
$item = @($backlog.items | Where-Object { $_.taskId -eq $taskId } | Select-Object -First 1)
if ($item.Count -ne 1) { throw "autonomous high-breakout discovery task disappeared task=$taskId" }
if ($item[0].status -eq 'QUEUED' -and -not $TestNow) {
    Write-Host "[high-breakout-discovery] QUEUED_WAITING_FOR_RESEARCH_WINDOW task=$taskId"
    exit 0
}
if ($item[0].status -ne 'COMPLETED') { throw "autonomous high-breakout discovery did not complete task=$taskId status=$($item[0].status)" }
if (-not (Test-CompletedResult $taskId)) { throw "autonomous high-breakout discovery result contract failed task=$taskId" }
Write-Host "[high-breakout-discovery] COMPLETE task=$taskId"
