[CmdletBinding()]
param(
    [string]$TaskName = 'AgentResearchNightlyOnce',
    [string]$At = '20:05'
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Runner = Join-Path $PSScriptRoot 'RUN_RESEARCH_WINDOW_ONCE.ps1'
if (-not (Test-Path $Runner)) { throw "runner not found: $Runner" }

$clock = [DateTime]::MinValue
if (-not [DateTime]::TryParseExact($At, 'HH:mm', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::None, [ref]$clock)) {
    throw "-At must be HH:mm, actual=$At"
}

$action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Runner`"" `
    -WorkingDirectory $Root

$trigger = New-ScheduledTaskTrigger -Daily -At $clock
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Hours 4)

$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited

$task = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description 'One-shot local research worker. Starts after market hours, processes at most one queued task, unloads Ollama models, then exits.'

Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
Write-Host "[research-schedule] INSTALLED task=$TaskName at=$At user=$currentUser"
Write-Host "[research-schedule] runner=$Runner"
Write-Host '[research-schedule] behavior=background one-shot; no resident agent loop'
