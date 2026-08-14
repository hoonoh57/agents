[CmdletBinding()]
param(
    [switch]$Mock
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $Root

function Get-EnvValue([string]$Name, [string]$Default = '') {
    $envFile = Join-Path $Root '.env'
    if (-not (Test-Path $envFile)) { return $Default }
    $line = Get-Content $envFile | Where-Object { $_ -match ('^\s*' + [regex]::Escape($Name) + '\s*=') } | Select-Object -Last 1
    if (-not $line) { return $Default }
    return (($line -split '=', 2)[1]).Trim().Trim('"').Trim("'")
}

function Get-KoreaNow {
    $tz = [System.TimeZoneInfo]::FindSystemTimeZoneById('Korea Standard Time')
    return [System.TimeZoneInfo]::ConvertTimeFromUtc([DateTime]::UtcNow, $tz)
}

function Parse-Clock([string]$Value, [string]$Name) {
    $parsed = [TimeSpan]::Zero
    if (-not [TimeSpan]::TryParseExact($Value, 'hh\:mm', [Globalization.CultureInfo]::InvariantCulture, [ref]$parsed)) {
        throw "$Name must be HH:mm, actual=$Value"
    }
    return $parsed
}

function Test-InWindow([TimeSpan]$Now, [TimeSpan]$Start, [TimeSpan]$End) {
    if ($Start -eq $End) { return $true }
    if ($Start -lt $End) { return ($Now -ge $Start -and $Now -lt $End) }
    return ($Now -ge $Start -or $Now -lt $End)
}

function Get-ConfiguredModels {
    $models = New-Object System.Collections.Generic.List[string]
    foreach ($envName in @('LOCAL_LLM_FAST_MODEL','LOCAL_LLM_REASONER_MODEL','LOCAL_LLM_CODER_MODEL')) {
        $value = Get-EnvValue $envName ''
        if ($value) { $models.Add($value) }
    }
    $registryFile = Join-Path $Root 'registry\models.json'
    if (Test-Path $registryFile) {
        $registry = Get-Content $registryFile -Raw -Encoding UTF8 | ConvertFrom-Json
        foreach ($row in $registry.roles) {
            if ($row.selectedModel) { $models.Add([string]$row.selectedModel) }
        }
    }
    return @($models | Where-Object { $_ } | Sort-Object -Unique)
}

function Unload-OllamaModels {
    $base = (Get-EnvValue 'LOCAL_LLM_BASE_URL' 'http://127.0.0.1:11434').TrimEnd('/')
    foreach ($model in Get-ConfiguredModels) {
        try {
            $body = @{ model = $model; messages = @(); stream = $false; keep_alive = 0 } | ConvertTo-Json -Depth 5 -Compress
            Invoke-RestMethod -Uri "$base/api/chat" -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 15 | Out-Null
            Write-Host "[research-window] UNLOAD model=$model"
        } catch {
            Write-Warning "[research-window] unload failed model=$model error=$($_.Exception.Message)"
        }
    }
}

$startText = Get-EnvValue 'AGENT_RESEARCH_WINDOW_START' '20:00'
$endText = Get-EnvValue 'AGENT_RESEARCH_WINDOW_END' '06:00'
$start = Parse-Clock $startText 'AGENT_RESEARCH_WINDOW_START'
$end = Parse-Clock $endText 'AGENT_RESEARCH_WINDOW_END'
$now = Get-KoreaNow

if (-not $Mock -and -not (Test-InWindow $now.TimeOfDay $start $end)) {
    Write-Host "[research-window] SKIP outside_window now=$($now.ToString('yyyy-MM-dd HH:mm:ss')) KST window=$startText-$endText"
    exit 0
}

Write-Host "[research-window] START now=$($now.ToString('yyyy-MM-dd HH:mm:ss')) KST window=$startText-$endText mode=$(if($Mock){'MOCK'}else{'LOCAL_LLM'})"
Write-Host '[research-window] policy=one-shot no-poll max-concurrency-1 unload-after-run'

# Defense in depth. Individual Ollama API requests may override OLLAMA_KEEP_ALIVE,
# so the finally block explicitly unloads every configured model with keep_alive=0.
$previousKeepAlive = $env:OLLAMA_KEEP_ALIVE
$previousWindowToken = $env:AGENT_RESEARCH_WINDOW_ACTIVE
$env:OLLAMA_KEEP_ALIVE = '0'
$env:AGENT_RESEARCH_WINDOW_ACTIVE = '1'
$worker = Join-Path $PSScriptRoot 'RUN_AGENT_ONCE.ps1'

try {
    if ($Mock) {
        & powershell -NoProfile -ExecutionPolicy Bypass -File $worker -Mock
    } else {
        & powershell -NoProfile -ExecutionPolicy Bypass -File $worker
    }
    $code = $LASTEXITCODE
    if ($code -ne 0) { throw "RUN_AGENT_ONCE failed exit=$code" }
} finally {
    if (-not $Mock) { Unload-OllamaModels }
    $env:OLLAMA_KEEP_ALIVE = $previousKeepAlive
    $env:AGENT_RESEARCH_WINDOW_ACTIVE = $previousWindowToken
}

Write-Host '[research-window] PASS process exits now'
