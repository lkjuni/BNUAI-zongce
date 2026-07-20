param(
  [ValidateSet(
    "002_audit_calculation_enhancements.sql",
    "003_system_result_management.sql",
    "004_auth_role_score_import.sql",
    "005_unique_rule_item_application.sql",
    "006_ai_audit.sql",
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
if ($LASTEXITCODE -ne 0) { throw "复制数据库迁移文件失败。" }
& $DockerExe exec $containerName sh -lc "mysql --default-character-set=utf8mb4 -uroot -proot123 bnuai_zongce < $remotePath"
if ($LASTEXITCODE -ne 0) { throw "执行数据库迁移失败。" }

Write-Output "Database migration applied: $MigrationFile"
