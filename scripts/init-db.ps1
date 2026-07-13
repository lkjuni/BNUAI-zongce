$ErrorActionPreference = "Stop"

. "$PSScriptRoot\common.ps1"

$containerName = "bnuai-zongce-mysql"
$schemaPath = Join-Path (Get-Location) "sql\schema.sql"

& $DockerExe cp $schemaPath "${containerName}:/tmp/schema.sql"
if ($LASTEXITCODE -ne 0) { throw "Failed to copy schema.sql into the MySQL container." }
& $DockerExe exec $containerName sh -lc "mysql --default-character-set=utf8mb4 -uroot -proot123 < /tmp/schema.sql"
if ($LASTEXITCODE -ne 0) { throw "Failed to rebuild the database schema." }

Write-Output "Database schema initialized."
