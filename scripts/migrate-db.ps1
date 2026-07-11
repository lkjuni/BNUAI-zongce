$ErrorActionPreference = "Stop"

$docker = "C:\Users\33267\AppData\Local\Programs\DockerDesktop\resources\bin\docker.exe"
if (!(Test-Path -LiteralPath $docker)) {
  $docker = "docker"
}

$env:PATH = "C:\Users\33267\AppData\Local\Programs\DockerDesktop\resources\bin;" + $env:PATH

$containerName = "bnuai-zongce-mysql"
$migrationPath = Join-Path (Get-Location) "sql\003_system_result_management.sql"

& $docker cp $migrationPath "${containerName}:/tmp/003_system_result_management.sql"
& $docker exec $containerName sh -lc "mysql --default-character-set=utf8mb4 -uroot -proot123 < /tmp/003_system_result_management.sql"

Write-Output "Database migration applied."
