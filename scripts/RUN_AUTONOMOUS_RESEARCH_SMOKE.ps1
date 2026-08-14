[CmdletBinding()]
param(
    [string]$ResearchRoot = 'E:\2026\opus\typescript\kiwoom-autotrade-template'
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $Root

function Invoke-NativeChecked {
    param([string]$Step, [scriptblock]$Command)
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $lines = @(& $Command 2>&1)
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $saved
    }
    $lines | ForEach-Object { Write-Host $_ }
    if ($code -ne 0) { throw "$Step failed exit=$code" }
    return $lines
}

if (-not (Test-Path (Join-Path $ResearchRoot '.git'))) {
    throw "Trading research repository not found: $ResearchRoot"
}

Write-Host '[autonomous-smoke] pull trading research repo'
Invoke-NativeChecked 'trading pull' { git -C $ResearchRoot pull --ff-only origin main } | Out-Null

$tool = Join-Path $ResearchRoot 'scripts\run_feature_experiment_tool.mjs'
if (-not (Test-Path $tool)) { throw "research tool missing: $tool" }
Write-Host '[autonomous-smoke] verify deterministic research tool'
Invoke-NativeChecked 'research tool parse' { node --check $tool } | Out-Null
Invoke-NativeChecked 'research tool self-test' { node $tool --self-test } | Out-Null

$dataset = 'c4f56e2dae66fa09739797c9bac43b82b48d972591fe618dff16e5d4bacb5b3f'
$snapshot = Join-Path $ResearchRoot ".research-data\EXP-MA-STATE-INCREMENTAL-001\snapshot-$dataset.json"
$manifest = Join-Path $ResearchRoot ".research-data\EXP-MA-STATE-INCREMENTAL-001\manifest-$dataset.json"
if (-not (Test-Path $snapshot) -or -not (Test-Path $manifest)) {
    throw "Frozen local research snapshot is missing for dataset=$dataset. Do not fabricate replacement data."
}

$worker = Join-Path $Root 'scripts\autonomous_research_smoke.mjs'
Write-Host '[autonomous-smoke] verify autonomous loop harness'
Invoke-NativeChecked 'autonomous harness parse' { node --check $worker } | Out-Null
Invoke-NativeChecked 'autonomous harness self-test' { node $worker --self-test } | Out-Null

$previousResearchRoot = $env:RESEARCH_LOCAL_ROOT
$env:RESEARCH_LOCAL_ROOT = $ResearchRoot
try {
    Write-Host '[autonomous-smoke] execute Local LLM -> DECISION -> ACTION -> TOOL -> EVIDENCE -> DECISION -> COMPLETE'
    $lines = Invoke-NativeChecked 'autonomous research smoke' { node $worker }
} finally {
    $env:RESEARCH_LOCAL_ROOT = $previousResearchRoot
}

$resultLine = @($lines | Where-Object { "$_" -match '^\[autonomous-smoke\] RESULT_PATH=' } | Select-Object -Last 1)
if ($resultLine.Count -ne 1) { throw 'RESULT_PATH was not emitted by autonomous smoke harness.' }
$resultPath = ("$($resultLine[0])" -replace '^\[autonomous-smoke\] RESULT_PATH=', '').Trim()
if (-not (Test-Path $resultPath)) { throw "result file missing: $resultPath" }
$result = Get-Content $resultPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($result.schema -ne 'AutonomousResearchSmokeResult@1.0.0' -or $result.status -ne 'PASS') {
    throw 'Autonomous smoke result did not PASS.'
}

$relativeDir = Join-Path 'experiments' (Join-Path 'AUTONOMOUS-RESEARCH-SMOKE' $result.runId)
$destDir = Join-Path $Root $relativeDir
New-Item -ItemType Directory -Force $destDir | Out-Null
$dest = Join-Path $destDir 'result.json'
Copy-Item -LiteralPath $resultPath -Destination $dest -Force

git -C $Root add -- $relativeDir
if ($LASTEXITCODE -ne 0) { throw 'git add smoke evidence failed' }
$staged = @(git -C $Root diff --cached --name-only)
if ($staged.Count -gt 0) {
    git -C $Root commit -m "Record autonomous research smoke evidence"
    if ($LASTEXITCODE -ne 0) { throw 'git commit smoke evidence failed' }
    git -C $Root push origin main
    if ($LASTEXITCODE -ne 0) { throw 'git push smoke evidence failed' }
}

Write-Host "[autonomous-smoke] PASS run=$($result.runId)"
Write-Host "[autonomous-smoke] RESULT=$dest"
