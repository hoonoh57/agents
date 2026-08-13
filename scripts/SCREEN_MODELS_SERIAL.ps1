param(
    [string[]]$Models = @('qwen3.6:35b-a3b', 'gpt-oss:20b'),
    [int]$Context = 4096,
    [int]$MaxOutput = 192,
    [int]$TimeoutSeconds = 60,
    [string]$Cases = 'REASON-INCREMENTAL-001,CODER-CONTRACT-001'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

foreach ($model in $Models) {
    Write-Host "[serial-screen] prepare $model"
    & ollama stop $model 2>$null | Out-Null

    $started = Get-Date
    Write-Host "[serial-screen] run $model"
    & node .\scripts\model_benchmark_chat.mjs run `
        --models $model `
        --context $Context `
        --max-output $MaxOutput `
        --timeout-seconds $TimeoutSeconds `
        --cases $Cases
    $exitCode = $LASTEXITCODE
    $elapsed = ((Get-Date) - $started).TotalSeconds

    Write-Host ("[serial-screen] unload {0} elapsed_s={1:N2}" -f $model, $elapsed)
    & ollama stop $model 2>$null | Out-Null

    if ($exitCode -ne 0) {
        Write-Host "[serial-screen] model command failed exit=$exitCode; continuing to next model"
    }
}

Write-Host '[serial-screen] DONE'
