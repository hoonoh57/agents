[CmdletBinding()]
param(
    [string]$ResearchRoot = 'E:\2026\opus\typescript\kiwoom-autotrade-template',
    [switch]$TestNow,
    [switch]$ForceNew
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $Root
$Template = 'feature-architect-next-trigger-v3.json'
$GoalId = 'GOAL-FEATURE-ARCHITECT-NEXT-TRIGGER-003'
$AgentId = 'feature-architect'

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

function Show-CompletedResult([string]$TaskId) {
    $path = Get-ResultPath $TaskId
    if (-not (Test-Path $path)) { return $false }
    $r = Get-Content $path -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($r.schema -ne 'AgentResult@1.0.0' -or $r.status -ne 'COMPLETED' -or $r.agentId -ne $AgentId) { return $false }
    if (-not $r.workProduct -or $r.workProduct.schema -ne 'AgentWorkProduct@1.0.0' -or $r.workProduct.profitabilityClaim -ne $false) { return $false }

    $verify = Invoke-NativeChecked 'feature design contract' { node .\scripts\verify_feature_design_contract.mjs --result $path }
    $verify | ForEach-Object { if ($_ -match 'FEATURE_DESIGN_CONTRACT_PASS') { Write-Host "[feature-architect-next] CONTRACT $_" } }

    Write-Host "[feature-architect-next] PASS task=$TaskId result=$($r.resultId) model=$($r.modelVersion) findings=$(@($r.workProduct.findings).Count) nextActions=$(@($r.workProduct.nextActions).Count)"
    Write-Host "[feature-architect-next] SUMMARY $($r.summary)"
    foreach ($finding in @($r.workProduct.findings | Where-Object { $_.kind -eq 'PROPOSAL' })) { Write-Host "[feature-architect-next] PROPOSAL $($finding.claim)" }
    foreach ($action in @($r.workProduct.nextActions)) { Write-Host "[feature-architect-next] NEXT $action" }
    return $true
}

Write-Host '[feature-architect-next] pull agents'
Invoke-NativeChecked 'agents pull' { git pull --ff-only origin main } | Out-Null

if (-not (Test-Path (Join-Path $ResearchRoot '.git'))) { throw "research repository not found: $ResearchRoot" }
Write-Host '[feature-architect-next] pull trading research repo'
Invoke-NativeChecked 'research pull' { git -C $ResearchRoot pull --ff-only origin main } | Out-Null

$env:RESEARCH_LOCAL_ROOT = $ResearchRoot
$env:AGENT_CONTEXT_MAX_BYTES = '22000'
$env:LOCAL_LLM_CONTEXT_TOKENS = '16384'
$env:LOCAL_LLM_MAX_OUTPUT_TOKENS = '1800'
$env:LOCAL_LLM_TIMEOUT_SECONDS = '120'

Write-Host '[feature-architect-next] verify source and scalar-transition design contracts'
Invoke-NativeChecked 'context adapter self-test' { node .\scripts\verify_project_context.mjs self-test } | Out-Null
Invoke-NativeChecked 'feature design contract self-test' { node .\scripts\verify_feature_design_contract.mjs --self-test } | Out-Null
Invoke-NativeChecked 'feature architect template context' { node .\scripts\verify_project_context.mjs template --template $Template } | Out-Null

$backlogPath = Join-Path $Root 'coordinator\BACKLOG.json'
$backlog = Get-Content $backlogPath -Raw -Encoding UTF8 | ConvertFrom-Json
$existing = @($backlog.items | Where-Object { $_.goalId -eq $GoalId } | Select-Object -Last 1)
if ($existing.Count -eq 1 -and -not $ForceNew) {
    $taskId = [string]$existing[0].taskId
    $status = [string]$existing[0].status
    $inboxPath = Join-Path $Root "agents\$AgentId\inbox\$taskId.json"
    if ($status -eq 'COMPLETED' -and (Show-CompletedResult $taskId)) { exit 0 }
    if ($status -eq 'RUNNING') { throw "task is already RUNNING: $taskId" }
    if ($status -eq 'QUEUED') {
        Write-Host "[feature-architect-next] resume queued task=$taskId"
    } elseif ($status -in @('ERROR','BLOCKED')) {
        if (-not (Test-Path $inboxPath)) { throw "failed task has no inbox snapshot: $taskId; use -ForceNew only for a deliberate new lineage" }
        Write-Host "[feature-architect-next] RETRY_SAME_LINEAGE task=$taskId previousStatus=$status"
    } else {
        throw "existing feature architecture task has unsupported status=$status task=$taskId"
    }
} else {
    Write-Host '[feature-architect-next] enqueue evidence-bound scalar-transition design task v3'
    $out = Invoke-NativeChecked 'enqueue feature architect task' { node .\scripts\agent_runtime_stable.mjs enqueue --template $Template }
    $joined = ($out -join "`n")
    if ($joined -notmatch 'ENQUEUED\s+(TASK-[A-Za-z0-9-]+)') { throw 'could not parse feature architect task id' }
    $taskId = $Matches[1]

    Write-Host "[feature-architect-next] persist queued task=$taskId"
    git add -- agents/feature-architect coordinator
    if ($LASTEXITCODE -ne 0) { throw 'git add queued feature architect task failed' }
    git commit -m 'Queue scalar-transition feature architecture task v3'
    if ($LASTEXITCODE -ne 0) { throw 'git commit queued feature architect task failed' }
    git push origin main
    if ($LASTEXITCODE -ne 0) { throw 'git push queued feature architect task failed' }
}

Write-Host "[feature-architect-next] execute one-shot worker task=$taskId testNow=$($TestNow.IsPresent)"
if ($TestNow) {
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\RUN_RESEARCH_WINDOW_ONCE.ps1 -TestNow
} else {
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\RUN_RESEARCH_WINDOW_ONCE.ps1
}
if ($LASTEXITCODE -ne 0) { throw "research-window worker failed exit=$LASTEXITCODE" }

if (Show-CompletedResult $taskId) { exit 0 }

$backlog = Get-Content $backlogPath -Raw -Encoding UTF8 | ConvertFrom-Json
$item = @($backlog.items | Where-Object { $_.taskId -eq $taskId } | Select-Object -First 1)
if ($item.Count -ne 1) { throw "feature architect task disappeared task=$taskId" }
if ($item[0].status -eq 'QUEUED' -and -not $TestNow) {
    Write-Host "[feature-architect-next] QUEUED_WAITING_FOR_RESEARCH_WINDOW task=$taskId"
    exit 0
}
$workPath = Join-Path $Root "agents\$AgentId\work\$taskId.json"
$detail = ''
if (Test-Path $workPath) {
    $work = Get-Content $workPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($work.error) { $detail = [string]$work.error }
}
throw "feature architect task did not produce a scalar-transition contract-valid result task=$taskId status=$($item[0].status) error=$detail"
