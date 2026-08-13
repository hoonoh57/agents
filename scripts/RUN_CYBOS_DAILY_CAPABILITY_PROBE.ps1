[CmdletBinding()]
param(
    [string]$Sma120Root = 'E:\2026\gpt\vb\sma120_solution',
    [string]$BaseUrl = 'http://127.0.0.1:18083'
)

$ErrorActionPreference = 'Stop'
$started = $null
$stdout = Join-Path $env:TEMP 'ma-state-cybos-probe.out.log'
$stderr = Join-Path $env:TEMP 'ma-state-cybos-probe.err.log'

function Try-Health {
    try { return Invoke-RestMethod -Uri "$BaseUrl/health" -Method Get -TimeoutSec 2 } catch { return $null }
}

if (-not (Test-Path (Join-Path $Sma120Root '.git'))) {
    throw "sma120_solution repository not found: $Sma120Root"
}

Write-Host '[cybos-capability] pull sma120_solution'
git -C $Sma120Root pull --ff-only origin main
if ($LASTEXITCODE -ne 0) { throw 'sma120_solution pull failed' }

$health = Try-Health
if ($null -eq $health) {
    Write-Host '[cybos-capability] build Server32 Release'
    $project = Join-Path $Sma120Root 'server32\Sma120.CybosServer32\Sma120.CybosServer32.vbproj'
    & dotnet build $project -c Release
    if ($LASTEXITCODE -ne 0) { throw 'CYBOS Server32 build failed' }

    $exe = Join-Path $Sma120Root 'server32\Sma120.CybosServer32\bin\Release\net8.0-windows\Sma120.CybosServer32.exe'
    if (-not (Test-Path $exe)) { throw "Server32 executable missing: $exe" }
    Remove-Item $stdout,$stderr -ErrorAction SilentlyContinue
    Write-Host '[cybos-capability] start temporary Server32 on 18083'
    $started = Start-Process -FilePath $exe -ArgumentList '--prefix','http://127.0.0.1:18083/' -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    for ($i=0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 1
        $health = Try-Health
        if ($null -ne $health) { break }
        if ($started.HasExited) { break }
    }
}

try {
    if ($null -eq $health) {
        if (Test-Path $stdout) { Get-Content $stdout -Tail 30 | ForEach-Object { Write-Host $_ } }
        if (Test-Path $stderr) { Get-Content $stderr -Tail 30 | ForEach-Object { Write-Host $_ } }
        throw 'CYBOS Server32 health endpoint did not become ready.'
    }
    Write-Host "[cybos-capability] health connected=$($health.isConnected) bitness=$($health.processBitness) status=$($health.status)"
    if (-not [bool]$health.isConnected) { throw 'CYBOS Plus is not connected.' }

    $probe = Join-Path $Sma120Root 'scripts\probe_daily_server32.ps1'
    if (-not (Test-Path $probe)) { throw "probe script missing: $probe" }
    powershell -NoProfile -ExecutionPolicy Bypass -File $probe -BaseUrl $BaseUrl
    if ($LASTEXITCODE -ne 0) { throw "CYBOS daily capability probe failed exit=$LASTEXITCODE" }
    Write-Host '[cybos-capability] PASS provider candidate is usable for snapshot design'
} finally {
    if ($null -ne $started -and -not $started.HasExited) {
        Write-Host "[cybos-capability] stop temporary Server32 pid=$($started.Id)"
        $saved = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try { & taskkill.exe /PID $started.Id /T /F 2>&1 | Out-Null } finally { $ErrorActionPreference = $saved }
    }
}
