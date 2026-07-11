$ErrorActionPreference = "Stop"

$docker = "C:\Users\33267\AppData\Local\Programs\DockerDesktop\resources\bin\docker.exe"
if (!(Test-Path -LiteralPath $docker)) {
  $docker = "docker"
}

$env:PATH = "C:\Users\33267\AppData\Local\Programs\DockerDesktop\resources\bin;" + $env:PATH

$containerName = "bnuai-zongce-mysql"
$existing = & $docker ps -a --filter "name=$containerName" --format "{{.Names}}"

if ($existing -contains $containerName) {
  & $docker start $containerName | Out-Null
} else {
  & $docker run `
    --name $containerName `
    -e MYSQL_ROOT_PASSWORD=root123 `
    -e MYSQL_DATABASE=bnuai_zongce `
    -e MYSQL_USER=zongce `
    -e MYSQL_PASSWORD=zongce123 `
    -p 3307:3306 `
    -d mysql:8.4 | Out-Null
}

for ($i = 0; $i -lt 60; $i++) {
  & $docker exec $containerName mysqladmin ping -uroot -proot123 --silent 2>$null
  if ($LASTEXITCODE -eq 0) {
    Write-Output "MySQL is ready on 127.0.0.1:3307"
    exit 0
  }
  Start-Sleep -Seconds 2
}

throw "MySQL container did not become ready in time."

