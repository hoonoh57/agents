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

Write-Host '[agents] pull'
git pull --ff-only origin main
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host '[agents] bootstrap agent workspaces'
node .\scripts\bootstrap_agent_workspaces.mjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$autoPush = (Get-EnvValue 'AGENT_AUTOPUSH' 'false').ToLowerInvariant() -eq 'true'
if (-not $autoPush) {
    Write-Host '[agents] AGENT_AUTOPUSH is not true; generated files remain local.'
    git status --short
    exit 0
}

$changes = git status --porcelain -- agents
if (-not $changes) {
    Write-Host '[agents] no workspace changes to push'
    exit 0
}

Write-Host '[agents] commit generated agent workspaces'
git add -- agents
git commit -m 'Bootstrap agent workspaces from registry'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

git push origin main
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host '[agents] PASS — local and origin/main synchronized'
