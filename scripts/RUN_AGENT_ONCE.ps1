param(
    [switch]$Mock
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Get-EnvValue([string]$Name, [string]$Default = '') {
    $envFile = Join-Path $root '.env'
    if (-not (Test-Path $envFile)) { return $Default }
    $line = Get-Content $envFile | Where-Object { $_ -match ('^\s*' + [regex]::Escape($Name) + '\s*=') } | Select-Object -Last 1
    if (-not $line) { return $Default }
    return (($line -split '=', 2)[1]).Trim().Trim('"').Trim("'")
}

Write-Host '[agent-worker] pull'
git pull --ff-only origin main
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host '[agent-worker] validate'
node .\scripts\agent_runtime_stable.mjs validate
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host '[agent-worker] run once'
if ($Mock) {
    node .\scripts\agent_runtime_stable.mjs worker-once --mock
} else {
    node .\scripts\agent_runtime_stable.mjs worker-once
}
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$changes = git status --porcelain -- agents coordinator
if (-not $changes) {
    Write-Host '[agent-worker] no durable changes'
    exit 0
}

$autoPush = (Get-EnvValue 'AGENT_AUTOPUSH' 'false').ToLowerInvariant() -eq 'true'
if (-not $autoPush) {
    Write-Host '[agent-worker] durable changes created; AGENT_AUTOPUSH=false'
    $changes | ForEach-Object { Write-Host $_ }
    exit 0
}

Write-Host '[agent-worker] commit/push durable agent state'
git add -- agents coordinator
git commit -m 'Process local agent task'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
git push origin main
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host '[agent-worker] PASS synchronized'
