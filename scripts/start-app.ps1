param(
  [int]$Port = 5173,
  [string]$BindHost = "0.0.0.0"
)

$ErrorActionPreference = "Stop"

$nodeExe = "C:\Users\33267\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if (!(Test-Path -LiteralPath $nodeExe)) {
  $nodeExe = "node"
}

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $projectRoot

Write-Output "Starting rule config demo..."
Write-Output "Open http://localhost:$Port after the server is ready."
Write-Output "LAN binding: http://${BindHost}:$Port"

$env:PORT = "$Port"
$env:BIND_HOST = "$BindHost"
& $nodeExe "src/server.js"
