$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

Write-Host '[agents] bootstrap workspaces'
node .\scripts\bootstrap_agent_workspaces.mjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ''
Write-Host '[agents] git status'
git status --short
