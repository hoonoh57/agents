param(
    [string]$ResearchRoot = 'E:\2026\opus\typescript\kiwoom-autotrade-template',
    [switch]$ForceNew
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$template = 'current-logic-baseline-review.json'
$goalId = 'GOAL-CURRENT-LOGIC-BASELINE-001'

function Get-EnvValue([string]$Name, [string]$Default = '') {
    $envFile = Join-Path $root '.env'
    if (-not (Test-Path $envFile)) { return $Default }
    $line = Get-Content $envFile | Where-Object { $_ -match ('^\s*' + [regex]::Escape($Name) + '\s*=') } | Select-Object -Last 1
    if (-not $line) { return $Default }
    return (($line -split '=', 2)[1]).Trim().Trim('"').Trim("'")
}

Write-Host '[first-current-logic] pull agents'
git pull --ff-only origin main
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if (-not (Test-Path (Join-Path $ResearchRoot '.git'))) {
    throw "research repository not found: $ResearchRoot"
}

$env:RESEARCH_LOCAL_ROOT = $ResearchRoot
$env:AGENT_CONTEXT_MAX_BYTES = '18000'
$env:LOCAL_LLM_CONTEXT_TOKENS = '8192'
$env:LOCAL_LLM_MAX_OUTPUT_TOKENS = '768'
$env:LOCAL_LLM_TIMEOUT_SECONDS = '120'

Write-Host '[first-current-logic] verify context adapter'
node .\scripts\verify_project_context.mjs self-test
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host '[first-current-logic] verify current project sources'
node .\scripts\verify_project_context.mjs template --template $template
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$backlogPath = Join-Path $root 'coordinator\BACKLOG.json'
$backlog = Get-Content $backlogPath -Raw -Encoding UTF8 | ConvertFrom-Json
$existing = $backlog.items | Where-Object { $_.goalId -eq $goalId -and $_.status -in @('QUEUED','RUNNING','COMPLETED') } | Select-Object -Last 1
if ($existing -and -not $ForceNew) {
    Write-Host "[first-current-logic] already exists task=$($existing.taskId) status=$($existing.status); use -ForceNew only for an intentional new evidence run"
    exit 0
}

Write-Host '[first-current-logic] enqueue evidence-bound task'
$enqueueOutput = & node .\scripts\agent_runtime_stable.mjs enqueue --template $template 2>&1
$enqueueOutput | ForEach-Object { Write-Host $_ }
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$joined = ($enqueueOutput -join "`n")
if ($joined -notmatch 'ENQUEUED\s+(TASK-[A-Za-z0-9-]+)') { throw 'could not parse task id' }
$taskId = $Matches[1]
$resultId = 'RESULT-' + $taskId.Substring(5)

$autoPush = (Get-EnvValue 'AGENT_AUTOPUSH' 'false').ToLowerInvariant() -eq 'true'
if ($autoPush) {
    Write-Host '[first-current-logic] commit/push queued task'
    git add -- agents/current-logic-analyst coordinator
    git commit -m 'Queue first real current logic research task'
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    git push origin main
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Write-Host "[first-current-logic] execute task=$taskId"
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\RUN_AGENT_ONCE.ps1
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$resultPath = Join-Path $root "agents\current-logic-analyst\results\$resultId.json"
if (-not (Test-Path $resultPath)) { throw "result missing: $resultPath" }
$result = Get-Content $resultPath -Raw -Encoding UTF8 | ConvertFrom-Json
Write-Host "[first-current-logic] PASS result=$resultId model=$($result.modelVersion) sources=$(@($result.sourceRefs).Count) findings=$(@($result.claims).Count)"
Write-Host "[first-current-logic] SUMMARY $($result.summary)"
if ($result.workProduct -and $result.workProduct.nextActions) {
    foreach ($action in @($result.workProduct.nextActions)) { Write-Host "[first-current-logic] NEXT $action" }
}
