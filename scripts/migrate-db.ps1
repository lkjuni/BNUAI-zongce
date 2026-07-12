param(
  [ValidateSet(
    "002_audit_calculation_enhancements.sql",
    "003_system_result_management.sql",
    "migrate-rule-node-aggregate.sql"
  )]
  [string]$MigrationFile = "003_system_result_management.sql"
)

$ErrorActionPreference = "Stop"

. "$PSScriptRoot\common.ps1"

$containerName = "bnuai-zongce-mysql"
$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$migrationPath = Join-Path $projectRoot "sql\$MigrationFile"
$remotePath = "/tmp/$MigrationFile"

# 历史迁移脚本只允许执行一次。升级旧数据库时必须明确选择迁移文件，
# 已成功执行的迁移不要重复运行。
& $DockerExe cp $migrationPath "${containerName}:$remotePath"
& $DockerExe exec $containerName sh -lc "mysql --default-character-set=utf8mb4 -uroot -proot123 < $remotePath"

Write-Output "Database migration applied: $MigrationFile"
