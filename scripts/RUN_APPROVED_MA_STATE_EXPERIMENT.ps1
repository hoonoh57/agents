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

function Get-FreeTcpPort {
    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    try {
        return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
    } finally {
        $listener.Stop()
    }
}

function Restore-EnvValue {
    param([string]$Name, [object]$Value)
    if ($null -eq $Value) {
        Remove-Item ("Env:{0}" -f $Name) -ErrorAction SilentlyContinue
    } else {
        Set-Item ("Env:{0}" -f $Name) -Value ([string]$Value)
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
$activeProxyBaseUrl = $ProxyBaseUrl
$oldProxyEnv = $env:KIWOOM_RESEARCH_PROXY_BASE_URL

try {
    $status = Get-ProxyStatus -BaseUrl $ProxyBaseUrl

    if ($status -and "$($status.mode)" -eq '실투자') {
        if (-not [bool]$status.tokenValid) {
            throw "existing real Kiwoom proxy has invalid token: $($status.error)"
        }
        Write-Host "[ma-state-approved] reuse real proxy at $ProxyBaseUrl tokenValid=$($status.tokenValid)"
    } else {
        if ($status) {
            Write-Host "[ma-state-approved] existing proxy mode=$($status.mode) at $ProxyBaseUrl; preserve it and start isolated real proxy"
        } else {
            Write-Host "[ma-state-approved] proxy unavailable at $ProxyBaseUrl; start isolated real proxy"
        }

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

        $realPort = Get-FreeTcpPort
        $activeProxyBaseUrl = "http://127.0.0.1:$realPort"
        $proxyLogDir = Join-Path $TradingRepo '.research-data\proxy'
        New-Item -ItemType Directory -Force $proxyLogDir | Out-Null
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $proxyStdout = Join-Path $proxyLogDir ("kiwoom-real-api-$stamp.stdout.log")
        $proxyStderr = Join-Path $proxyLogDir ("kiwoom-real-api-$stamp.stderr.log")

        $oldMock = $env:KIWOOM_MOCK
        $oldPort = $env:PORT
        try {
            $env:KIWOOM_MOCK = 'false'
            $env:PORT = [string]$realPort
            $startedProxy = Start-Process -FilePath 'node.exe' -ArgumentList @($tsxCli, 'server/index.ts') -WorkingDirectory $KiwoomDeskRepo -WindowStyle Hidden -RedirectStandardOutput $proxyStdout -RedirectStandardError $proxyStderr -PassThru
        } finally {
            Restore-EnvValue -Name 'KIWOOM_MOCK' -Value $oldMock
            Restore-EnvValue -Name 'PORT' -Value $oldPort
        }

        $status = $null
        for ($i = 0; $i -lt 40; $i++) {
            Start-Sleep -Milliseconds 500
            if ($startedProxy.HasExited) { break }
            $status = Get-ProxyStatus -BaseUrl $activeProxyBaseUrl
            if ($status) { break }
        }
        if (-not $status) {
            Show-ProxyLogs -StdoutPath $proxyStdout -StderrPath $proxyStderr
            throw "real Kiwoom API proxy did not become ready at $activeProxyBaseUrl"
        }
        if ("$($status.mode)" -ne '실투자') {
            Show-ProxyLogs -StdoutPath $proxyStdout -StderrPath $proxyStderr
            throw "isolated proxy did not enter real mode: mode=$($status.mode)"
        }
        if (-not [bool]$status.tokenValid) {
            Show-ProxyLogs -StdoutPath $proxyStdout -StderrPath $proxyStderr
            throw "real Kiwoom proxy token is invalid: $($status.error)"
        }
        Write-Host "[ma-state-approved] isolated real proxy ready at $activeProxyBaseUrl tokenValid=$($status.tokenValid)"
    }

    $env:KIWOOM_RESEARCH_PROXY_BASE_URL = $activeProxyBaseUrl

    Write-Host '[ma-state-approved] execute read-only real-data experiment'
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
    Restore-EnvValue -Name 'KIWOOM_RESEARCH_PROXY_BASE_URL' -Value $oldProxyEnv
    if ($startedProxy -and -not $startedProxy.HasExited) {
        Write-Host "[ma-state-approved] stop temporary real Kiwoom API pid=$($startedProxy.Id)"
        $savedPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try { & taskkill.exe /PID $startedProxy.Id /T /F 2>&1 | Out-Null } finally { $ErrorActionPreference = $savedPreference }
    }
}
