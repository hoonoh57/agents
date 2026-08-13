$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$envExample = Join-Path $root '.env.example'
$envFile = Join-Path $root '.env'

if (-not (Test-Path -LiteralPath $envExample)) {
    throw ".env.example not found: $envExample"
}

if (-not (Test-Path -LiteralPath $envFile)) {
    Copy-Item -LiteralPath $envExample -Destination $envFile
    Write-Host "created .env"
} else {
    Write-Host ".env already exists - preserved"
}

$dirs = @(
    'runtime',
    'logs',
    'cache',
    'research-data',
    'research-artifacts',
    'vector-index',
    'model-cache',
    'experiment-cache',
    'charts'
)

foreach ($dir in $dirs) {
    $path = Join-Path $root $dir
    if (-not (Test-Path -LiteralPath $path)) {
        New-Item -ItemType Directory -Path $path | Out-Null
        Write-Host "created $dir"
    }
}

Write-Host ""
Write-Host "Agents local workspace ready: $root"
Write-Host "Edit .env only for machine-local values/secrets. .env is gitignored."
