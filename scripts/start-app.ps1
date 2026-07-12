param(
  [int]$Port = 5173,
  [string]$BindHost = "0.0.0.0"
)

$ErrorActionPreference = "Stop"

. "$PSScriptRoot\common.ps1"

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $projectRoot

Write-Output "Starting rule config demo..."
Write-Output "Open http://localhost:$Port after the server is ready."
Write-Output "LAN binding: http://${BindHost}:$Port"

$env:PORT = "$Port"
$env:BIND_HOST = "$BindHost"
& $NodeExe "src/server.js"
