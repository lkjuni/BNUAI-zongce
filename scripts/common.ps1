# scripts/common.ps1
# 共享工具函数：自动查找 Node.js 和 Docker 可执行文件路径。
# 所有脚本 dot-source 本文件后即可使用 $NodeExe 和 $DockerExe。
# 查找是惰性的——仅在首次访问对应变量时触发，不影响不需要该工具的脚本。

# 缓存变量（脚本级私有）
$_common_nodeExe = $null
$_common_dockerExe = $null

function Find-NodeExe {
    <#
    .SYNOPSIS
        查找 Node.js 可执行文件的完整路径。
        优先使用 PATH 中的 node，其次按常见安装位置搜索。
    #>
    if ($_common_nodeExe) { return $_common_nodeExe }

    # 1) 通过 Get-Command 搜索 PATH
    $cmd = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
    if ($cmd) {
        $_common_nodeExe = $cmd.Source
        return $_common_nodeExe
    }

    # 2) 常见安装位置
    $candidates = @(
        "$env:ProgramFiles\nodejs\node.exe",
        "${env:ProgramFiles(x86)}\nodejs\node.exe",
        "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
    )
    # Codex runtime (VS Code 内置)
    $codexRoot = "$env:USERPROFILE\.cache\codex-runtimes"
    if (Test-Path $codexRoot) {
        $candidates += Get-ChildItem "$codexRoot\*\dependencies\node\bin\node.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName
    }
    # nvm-windows
    if (Test-Path "$env:LOCALAPPDATA\nvm") {
        $candidates += Get-ChildItem "$env:LOCALAPPDATA\nvm\*\node.exe" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName
    }
    # fnm
    if (Test-Path "$env:LOCALAPPDATA\fnm") {
        $candidates += Get-ChildItem "$env:LOCALAPPDATA\fnm\node-versions\*\node.exe" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName
    }

    foreach ($p in $candidates) {
        if (Test-Path -LiteralPath $p) {
            $_common_nodeExe = $p
            return $_common_nodeExe
        }
    }

    throw "Cannot find node.exe. Install Node.js (https://nodejs.org) and add it to PATH."
}

function Find-DockerExe {
    <#
    .SYNOPSIS
        查找 Docker 可执行文件的完整路径。
    #>
    if ($_common_dockerExe) { return $_common_dockerExe }

    $cmd = Get-Command docker -CommandType Application -ErrorAction SilentlyContinue
    if ($cmd) {
        $_common_dockerExe = $cmd.Source
        return $_common_dockerExe
    }

    $candidates = @(
        "$env:ProgramFiles\Docker\Docker\resources\bin\docker.exe",
        "${env:ProgramFiles(x86)}\Docker\Docker\resources\bin\docker.exe"
    )
    foreach ($p in $candidates) {
        if (Test-Path -LiteralPath $p) {
            $_common_dockerExe = $p
            return $_common_dockerExe
        }
    }

    throw "Cannot find docker.exe. Install Docker Desktop (https://www.docker.com) and add it to PATH."
}

# 导出 Node.js（所有脚本都需要，导入时自动查找）
$NodeExe = Find-NodeExe

# Docker（仅 init-db / start-mysql / migrate-db 需要，查找失败不阻断导入）
try {
    $DockerExe = Find-DockerExe
} catch {
    $DockerExe = $null
}
