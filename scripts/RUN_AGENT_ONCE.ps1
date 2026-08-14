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

function Get-RegistryModel([string]$Role) {
    $registryFile = Join-Path $root 'registry\models.json'
    if (-not (Test-Path $registryFile)) { return '' }
    $registry = Get-Content $registryFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $row = $registry.roles | Where-Object { $_.role -eq $Role } | Select-Object -First 1
    if (-not $row -or -not $row.selectedModel) { return '' }
    return [string]$row.selectedModel
}

function Set-ModelDefault([string]$EnvName, [string]$Role) {
    $configured = Get-EnvValue $EnvName ''
    if ($configured) {
        [Environment]::SetEnvironmentVariable($EnvName, $configured, 'Process')
        Write-Host "[agent-worker] model $Role=$configured source=.env"
        return
    }
    $selected = Get-RegistryModel $Role
    if (-not $selected) {
        Write-Host "[agent-worker] model $Role=UNCONFIGURED"
        return
    }
    [Environment]::SetEnvironmentVariable($EnvName, $selected, 'Process')
    Write-Host "[agent-worker] model $Role=$selected source=registry"
}

# Production local-LLM work must be launched by RUN_RESEARCH_WINDOW_ONCE.ps1.
# Mock lifecycle verification is allowed without the production window token because it does not invoke Ollama.
if (-not $Mock -and $env:AGENT_RESEARCH_WINDOW_ACTIVE -ne '1') {
    throw 'Production local LLM worker is blocked. Use scripts\RUN_RESEARCH_WINDOW_ONCE.ps1 after hours or with explicit -TestNow during development.'
}

Write-Host '[agent-worker] pull'
git pull --ff-only origin main
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Set-ModelDefault 'LOCAL_LLM_FAST_MODEL' 'LOCAL_FAST'
Set-ModelDefault 'LOCAL_LLM_REASONER_MODEL' 'LOCAL_REASONER'
Set-ModelDefault 'LOCAL_LLM_CODER_MODEL' 'LOCAL_CODER'

Write-Host '[agent-worker] validate stable runtime'
node .\scripts\agent_runtime_stable.mjs validate
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host '[agent-worker] validate one-shot router + autonomous engine'
node --check .\scripts\agent_worker_router.mjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
node --check .\scripts\autonomous_research_engine.mjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
node .\scripts\agent_worker_router.mjs self-test
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host '[agent-worker] run once through router'
if ($Mock) {
    node .\scripts\agent_worker_router.mjs worker-once --mock
} else {
    node .\scripts\agent_worker_router.mjs worker-once
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
