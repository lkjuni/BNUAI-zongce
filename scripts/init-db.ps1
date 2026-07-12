$ErrorActionPreference = "Stop"

. "$PSScriptRoot\common.ps1"

$containerName = "bnuai-zongce-mysql"
$schemaPath = Join-Path (Get-Location) "sql\schema.sql"

& $DockerExe cp $schemaPath "${containerName}:/tmp/schema.sql"
& $DockerExe exec $containerName sh -lc "mysql --default-character-set=utf8mb4 -uroot -proot123 < /tmp/schema.sql"

Write-Output "Database schema initialized."

