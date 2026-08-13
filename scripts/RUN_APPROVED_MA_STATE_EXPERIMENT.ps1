param(
    [string]$TradingRepo = 'E:\2026\opus\typescript\kiwoom-autotrade-template'
)

$ErrorActionPreference = 'Stop'
$AgentsRepo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Runner = Join-Path $TradingRepo 'scripts\run_ma_state_incremental_experiment.mjs'

Write-Host '[ma-state-approved] pull trading repo'
git -C $TradingRepo pull --ff-only origin main
if ($LASTEXITCODE -ne 0) { throw 'trading repo pull failed' }

Write-Host '[ma-state-approved] parse runner'
node --check $Runner
if ($LASTEXITCODE -ne 0) { throw 'runner parse failed' }

Write-Host '[ma-state-approved] verify frozen contract'
node $Runner --self-test
if ($LASTEXITCODE -ne 0) { throw 'runner self-test failed' }

Write-Host '[ma-state-approved] execute read-only real-data experiment'
$lines = @(& node $Runner 2>&1)
$code = $LASTEXITCODE
$lines | ForEach-Object { Write-Host $_ }
if ($code -ne 0) { throw "experiment failed exit=$code" }

$resultLine = $lines | Where-Object { "$_" -match '^\[ma-state-exp\] RESULT_PATH=' } | Select-Object -Last 1
if (-not $resultLine) { throw 'RESULT_PATH missing from experiment output' }
$resultPath = ("$resultLine" -replace '^\[ma-state-exp\] RESULT_PATH=', '').Trim()
if (-not (Test-Path -LiteralPath $resultPath)) { throw "result file missing: $resultPath" }

$result = Get-Content -LiteralPath $resultPath -Raw -Encoding UTF8 | ConvertFrom-Json
$datasetHash = "$($result.datasetHash)".Trim()
if (-not $datasetHash) { throw 'datasetHash missing from result evidence' }
$sourceDir = Split-Path -Parent $resultPath
$manifestPath = Join-Path $sourceDir ("manifest-{0}.json" -f $datasetHash)
if (-not (Test-Path -LiteralPath $manifestPath)) { throw "manifest file missing: $manifestPath" }

$evidenceDir = Join-Path $AgentsRepo ("experiments\EXP-MA-STATE-INCREMENTAL-001\{0}" -f $datasetHash)
New-Item -ItemType Directory -Force $evidenceDir | Out-Null
Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $evidenceDir 'manifest.json') -Force
Copy-Item -LiteralPath $resultPath -Destination (Join-Path $evidenceDir 'result.json') -Force

Write-Host "[ma-state-approved] evidence dataset=$datasetHash"
git -C $AgentsRepo add -- (Join-Path 'experiments' (Join-Path 'EXP-MA-STATE-INCREMENTAL-001' $datasetHash))
$staged = git -C $AgentsRepo diff --cached --name-only
if ($staged) {
    git -C $AgentsRepo commit -m "Record EXP-MA-STATE-INCREMENTAL-001 evidence"
    if ($LASTEXITCODE -ne 0) { throw 'evidence commit failed' }
    git -C $AgentsRepo push origin main
    if ($LASTEXITCODE -ne 0) { throw 'evidence push failed' }
}

Write-Host '[ma-state-approved] PASS evidence synchronized'
Write-Host "[ma-state-approved] RESULT=$evidenceDir\result.json"
