param(
    [string]$Target = 'E:\2026\opus\typescript\kiwoom-autotrade-template',
    [string]$Models = 'qwen3.6:35b-a3b,gemma4:12b',
    [int]$Context = 4096,
    [int]$MaxOutput = 256,
    [int]$TimeoutSeconds = 90
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not (Test-Path (Join-Path $Target '.git'))) {
    throw "target repository not found: $Target"
}

Write-Host '[real-project] self-test'
& node .\scripts\real_project_benchmark.mjs self-test
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host '[real-project] run finalists'
& node .\scripts\real_project_benchmark.mjs run `
    --target $Target `
    --models $Models `
    --context $Context `
    --max-output $MaxOutput `
    --timeout-seconds $TimeoutSeconds
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

function Get-EnvValue([string]$Name, [string]$Default = '') {
    $envFile = Join-Path $root '.env'
    if (-not (Test-Path $envFile)) { return $Default }
    $line = Get-Content $envFile | Where-Object { $_ -match ('^\s*' + [regex]::Escape($Name) + '\s*=') } | Select-Object -Last 1
    if (-not $line) { return $Default }
    return (($line -split '=', 2)[1]).Trim().Trim('"').Trim("'")
}

$autoPush = (Get-EnvValue 'AGENT_AUTOPUSH' 'false').ToLowerInvariant() -eq 'true'
$changes = git status --porcelain -- benchmarks/real-project/results
if (-not $changes) {
    Write-Host '[real-project] no result changes to commit'
    exit 0
}

if (-not $autoPush) {
    Write-Host '[real-project] result generated; AGENT_AUTOPUSH is not true'
    git status --short -- benchmarks/real-project/results
    exit 0
}

Write-Host '[real-project] commit benchmark evidence'
git add -- benchmarks/real-project/results
git commit -m 'Record real-project local model benchmark'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
git push origin main
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host '[real-project] PASS result committed and pushed'
