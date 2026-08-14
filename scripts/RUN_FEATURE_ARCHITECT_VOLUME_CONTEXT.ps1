[CmdletBinding()]
param(
    [string]$ResearchRoot = 'E:\2026\opus\typescript\kiwoom-autotrade-template',
    [switch]$TestNow,
    [switch]$ForceNew
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $Root
$Template = 'feature-architect-volume-context-v1.json'
$GoalId = 'GOAL-FEATURE-ARCHITECT-VOLUME-CONTEXT-001'
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

    $verify = Invoke-NativeChecked 'volume context design contract' { node .\scripts\verify_volume_context_design_contract.mjs --result $path }
    $verify | ForEach-Object { if ($_ -match 'VOLUME_CONTEXT_DESIGN_CONTRACT_PASS') { Write-Host "[feature-volume-context] CONTRACT $_" } }

    Write-Host "[feature-volume-context] PASS task=$TaskId result=$($r.resultId) model=$($r.modelVersion) findings=$(@($r.workProduct.findings).Count) nextActions=$(@($r.workProduct.nextActions).Count)"
    Write-Host "[feature-volume-context] SUMMARY $($r.summary)"
    foreach ($finding in @($r.workProduct.findings | Where-Object { $_.kind -eq 'PROPOSAL' })) { Write-Host "[feature-volume-context] PROPOSAL $($finding.claim)" }
    foreach ($action in @($r.workProduct.nextActions)) { Write-Host "[feature-volume-context] NEXT $action" }
    return $true
}

Write-Host '[feature-volume-context] pull agents'
Invoke-NativeChecked 'agents pull' { git pull --ff-only origin main } | Out-Null

if (-not (Test-Path (Join-Path $ResearchRoot '.git'))) { throw "research repository not found: $ResearchRoot" }
Write-Host '[feature-volume-context] pull trading research repo'
Invoke-NativeChecked 'research pull' { git -C $ResearchRoot pull --ff-only origin main } | Out-Null

$env:RESEARCH_LOCAL_ROOT = $ResearchRoot
$env:AGENT_CONTEXT_MAX_BYTES = '36000'
$env:LOCAL_LLM_CONTEXT_TOKENS = '16384'
$env:LOCAL_LLM_MAX_OUTPUT_TOKENS = '1800'
$env:LOCAL_LLM_TIMEOUT_SECONDS = '120'

Write-Host '[feature-volume-context] verify source provenance and composite design contract'
Invoke-NativeChecked 'context adapter self-test' { node .\scripts\verify_project_context.mjs self-test } | Out-Null
Invoke-NativeChecked 'volume context contract self-test' { node .\scripts\verify_volume_context_design_contract.mjs --self-test } | Out-Null
Invoke-NativeChecked 'volume context template context' { node .\scripts\verify_project_context.mjs template --template $Template } | Out-Null

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
        Write-Host "[feature-volume-context] resume queued task=$taskId"
    } elseif ($status -in @('ERROR','BLOCKED')) {
        if (-not (Test-Path $inboxPath)) { throw "failed task has no inbox snapshot: $taskId; use -ForceNew only for a deliberate new lineage" }
        Write-Host "[feature-volume-context] RETRY_SAME_LINEAGE task=$taskId previousStatus=$status"
    } else {
        throw "existing volume context architecture task has unsupported status=$status task=$taskId"
    }
} else {
    Write-Host '[feature-volume-context] enqueue new composite context design task'
    $out = Invoke-NativeChecked 'enqueue feature architect volume context task' { node .\scripts\agent_runtime_stable.mjs enqueue --template $Template }
    $joined = ($out -join "`n")
    if ($joined -notmatch 'ENQUEUED\s+(TASK-[A-Za-z0-9-]+)') { throw 'could not parse feature architect volume context task id' }
    $taskId = $Matches[1]

    Write-Host "[feature-volume-context] persist queued task=$taskId"
    git add -- agents/feature-architect coordinator
    if ($LASTEXITCODE -ne 0) { throw 'git add queued volume context task failed' }
    git commit -m 'Queue feature architect volume context task'
    if ($LASTEXITCODE -ne 0) { throw 'git commit queued volume context task failed' }
    git push origin main
    if ($LASTEXITCODE -ne 0) { throw 'git push queued volume context task failed' }
}

Write-Host "[feature-volume-context] execute targeted one-shot worker task=$taskId testNow=$($TestNow.IsPresent)"
if ($TestNow) {
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\RUN_RESEARCH_WINDOW_ONCE.ps1 -TestNow -TaskId $taskId
} else {
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\RUN_RESEARCH_WINDOW_ONCE.ps1 -TaskId $taskId
}
if ($LASTEXITCODE -ne 0) { throw "research-window worker failed exit=$LASTEXITCODE" }

if (Show-CompletedResult $taskId) { exit 0 }

$backlog = Get-Content $backlogPath -Raw -Encoding UTF8 | ConvertFrom-Json
$item = @($backlog.items | Where-Object { $_.taskId -eq $taskId } | Select-Object -First 1)
if ($item.Count -ne 1) { throw "feature architect volume context task disappeared task=$taskId" }
if ($item[0].status -eq 'QUEUED' -and -not $TestNow) {
    Write-Host "[feature-volume-context] QUEUED_WAITING_FOR_RESEARCH_WINDOW task=$taskId"
    exit 0
}
$workPath = Join-Path $Root "agents\$AgentId\work\$taskId.json"
$detail = ''
if (Test-Path $workPath) {
    $work = Get-Content $workPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($work.error) { $detail = [string]$work.error }
}
throw "feature architect volume context task did not produce a contract-valid result task=$taskId status=$($item[0].status) error=$detail"
