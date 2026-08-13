param(
    [string]$TradingRepo = 'E:\2026\opus\typescript\kiwoom-autotrade-template',
    [string]$KiwoomDeskRepo = '',
    [string]$ProxyBaseUrl = 'http://127.0.0.1:3010'
)

$ErrorActionPreference = 'Stop'
$AgentsRepo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Runner = Join-Path $TradingRepo 'scripts\run_ma_state_incremental_experiment.mjs'
if (-not $KiwoomDeskRepo) {
    $KiwoomDeskRepo = Join-Path (Split-Path -Parent $TradingRepo) 'kiwoom-desk'
}

function Get-ProxyStatus {
    param([string]$BaseUrl)
    try {
        return Invoke-RestMethod -Uri ($BaseUrl.TrimEnd('/') + '/api/kiwoom/status') -Method Get -TimeoutSec 3
    } catch {
        return $null
    }
}

function Show-ProxyLogs {
    param([string]$StdoutPath, [string]$StderrPath)
    if ($StdoutPath -and (Test-Path -LiteralPath $StdoutPath)) {
        Write-Host '[ma-state-approved] proxy stdout tail'
        Get-Content -LiteralPath $StdoutPath -Tail 30 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
    }
    if ($StderrPath -and (Test-Path -LiteralPath $StderrPath)) {
        Write-Host '[ma-state-approved] proxy stderr tail'
        Get-Content -LiteralPath $StderrPath -Tail 30 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
    }
}

Write-Host '[ma-state-approved] pull trading repo'
git -C $TradingRepo pull --ff-only origin main
if ($LASTEXITCODE -ne 0) { throw 'trading repo pull failed' }

Write-Host '[ma-state-approved] parse runner'
node --check $Runner
if ($LASTEXITCODE -ne 0) { throw 'runner parse failed' }

Write-Host '[ma-state-approved] verify frozen contract'
node $Runner --self-test
if ($LASTEXITCODE -ne 0) { throw 'runner self-test failed' }

$startedProxy = $null
$proxyStdout = $null
$proxyStderr = $null
$oldProxyEnv = $env:KIWOOM_RESEARCH_PROXY_BASE_URL

try {
    $status = Get-ProxyStatus -BaseUrl $ProxyBaseUrl
    if ($status) {
        if (-not [bool]$status.tokenValid) {
            throw "existing Kiwoom proxy token is invalid: mode=$($status.mode) error=$($status.error)"
        }
        Write-Host "[ma-state-approved] reuse proxy at $ProxyBaseUrl mode=$($status.mode) tokenValid=$($status.tokenValid)"
    } else {
        Write-Host "[ma-state-approved] proxy unavailable at $ProxyBaseUrl; start kiwoom-desk API with its configured mode"
        if (-not (Test-Path -LiteralPath $KiwoomDeskRepo)) {
            throw "kiwoom-desk repo not found: $KiwoomDeskRepo"
        }
        $serverFile = Join-Path $KiwoomDeskRepo 'server\index.ts'
        $tsxCli = Join-Path $KiwoomDeskRepo 'node_modules\tsx\dist\cli.mjs'
        if (-not (Test-Path -LiteralPath $serverFile)) {
            throw "Kiwoom API server source missing: $serverFile"
        }
        if (-not (Test-Path -LiteralPath $tsxCli)) {
            throw "kiwoom-desk dependencies missing. Run once: Set-Location '$KiwoomDeskRepo'; npm install"
        }

        $proxyLogDir = Join-Path $TradingRepo '.research-data\proxy'
        New-Item -ItemType Directory -Force $proxyLogDir | Out-Null
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $proxyStdout = Join-Path $proxyLogDir ("kiwoom-api-$stamp.stdout.log")
        $proxyStderr = Join-Path $proxyLogDir ("kiwoom-api-$stamp.stderr.log")
        $startedProxy = Start-Process -FilePath 'node.exe' -ArgumentList @($tsxCli, 'server/index.ts') -WorkingDirectory $KiwoomDeskRepo -WindowStyle Hidden -RedirectStandardOutput $proxyStdout -RedirectStandardError $proxyStderr -PassThru

        for ($i = 0; $i -lt 40; $i++) {
            Start-Sleep -Milliseconds 500
            if ($startedProxy.HasExited) { break }
            $status = Get-ProxyStatus -BaseUrl $ProxyBaseUrl
            if ($status) { break }
        }
        if (-not $status) {
            Show-ProxyLogs -StdoutPath $proxyStdout -StderrPath $proxyStderr
            throw "Kiwoom API proxy did not become ready at $ProxyBaseUrl"
        }
        if (-not [bool]$status.tokenValid) {
            Show-ProxyLogs -StdoutPath $proxyStdout -StderrPath $proxyStderr
            throw "Kiwoom proxy token is invalid: mode=$($status.mode) error=$($status.error)"
        }
        Write-Host "[ma-state-approved] temporary proxy ready mode=$($status.mode) tokenValid=$($status.tokenValid)"
    }

    Write-Host '[ma-state-approved] proxy mode is provenance only; historical ka10081 research accepts mock or real'
    $env:KIWOOM_RESEARCH_PROXY_BASE_URL = $ProxyBaseUrl

    Write-Host '[ma-state-approved] execute read-only historical-data experiment'
    $savedPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $lines = @(& node $Runner 2>&1)
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $savedPreference
    }
    $lines | ForEach-Object { Write-Host $_ }
    if ($code -ne 0) {
        Show-ProxyLogs -StdoutPath $proxyStdout -StderrPath $proxyStderr
        throw "experiment failed exit=$code"
    }

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
} finally {
    if ($null -eq $oldProxyEnv) {
        Remove-Item Env:KIWOOM_RESEARCH_PROXY_BASE_URL -ErrorAction SilentlyContinue
    } else {
        $env:KIWOOM_RESEARCH_PROXY_BASE_URL = $oldProxyEnv
    }
    if ($startedProxy -and -not $startedProxy.HasExited) {
        Write-Host "[ma-state-approved] stop temporary Kiwoom API pid=$($startedProxy.Id)"
        $savedPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try { & taskkill.exe /PID $startedProxy.Id /T /F 2>&1 | Out-Null } finally { $ErrorActionPreference = $savedPreference }
    }
}
