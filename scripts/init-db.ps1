$ErrorActionPreference = "Stop"

$docker = "C:\Users\33267\AppData\Local\Programs\DockerDesktop\resources\bin\docker.exe"
if (!(Test-Path -LiteralPath $docker)) {
  $docker = "docker"
}

$env:PATH = "C:\Users\33267\AppData\Local\Programs\DockerDesktop\resources\bin;" + $env:PATH

$containerName = "bnuai-zongce-mysql"
$schemaPath = Join-Path (Get-Location) "sql\schema.sql"

& $docker cp $schemaPath "${containerName}:/tmp/schema.sql"
& $docker exec $containerName sh -lc "mysql --default-character-set=utf8mb4 -uroot -proot123 < /tmp/schema.sql"

Write-Output "Database schema initialized."

