$ErrorActionPreference = "Stop"

. "$PSScriptRoot\common.ps1"

$containerName = "bnuai-zongce-mysql"
$existing = & $DockerExe ps -a --filter "name=$containerName" --format "{{.Names}}"

if ($existing -contains $containerName) {
  & $DockerExe start $containerName | Out-Null
} else {
  & $DockerExe run `
    --name $containerName `
    -e MYSQL_ROOT_PASSWORD=root123 `
    -e MYSQL_DATABASE=bnuai_zongce `
    -e MYSQL_USER=zongce `
    -e MYSQL_PASSWORD=zongce123 `
    -p 3307:3306 `
    -d mysql:8.4 | Out-Null
}

for ($i = 0; $i -lt 60; $i++) {
  & $DockerExe exec $containerName mysqladmin ping -uroot -proot123 --silent 2>$null
  if ($LASTEXITCODE -eq 0) {
    Write-Output "MySQL is ready on 127.0.0.1:3307"
    exit 0
  }
  Start-Sleep -Seconds 2
}

throw "MySQL container did not become ready in time."

