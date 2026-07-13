# 综合测评自动算分系统

本项目是面向学院本科生综合测评业务的可运行原型，覆盖角色登录、规则集与学年管理、学生申报与材料提交、审核、学委/学院统一上传、自动核算、结果统计与公示，以及学生和用户管理。

系统当前采用原生 Node.js HTTP 服务、MySQL 8.4 和原生 HTML/CSS/JavaScript。前后端由同一个 Node 进程提供，适合验证数据库模型和完整业务链路。

## 核心业务约定

- 规则由“规则集 → 规则版本 → 规则树”表达。
- 规则树节点只分为 `aggregate`（汇总节点）和 `item`（规则项）。模块、分类和子分类由父子关系自然表达。
- 学年绑定规则快照，申报、审核和核算都保留对应的学年与快照信息。
- 一条 `application_record` 是申报和审核的最小颗粒度。
- 审核最终通过后自动核算；规则快照变化且已有通过申报时自动重算。
- 学委或学院统一上传会生成受信的已批准申报，再自动核算，不直接修改最终总分。
- 核算先得到每条申报的基础分，再沿规则树执行求和、取最高和封顶等汇总规则。
- 有业务数据的学年默认归档；只有有效的 `super_admin` 经过二次确认后才能彻底删除。

## 目录结构

```text
BNUAI_zongce/
├─ README.md                         # 项目入口、运行和验证说明
├─ package.json                      # Node.js 项目元数据与启动命令
├─ pnpm-lock.yaml                    # 依赖锁文件
├─ .env.example                      # 环境变量示例
├─ public/                           # 浏览器端静态资源
│  ├─ index.html                     # 页面结构与各业务模块表单
│  ├─ app.js                         # 前端状态、接口调用和交互逻辑
│  └─ styles.css                     # 页面布局与视觉样式
├─ src/                              # Node.js 后端代码
│  ├─ server.js                      # HTTP 入口、规则/学年 API、静态资源服务
│  ├─ db.js                          # MySQL 连接池、查询和事务封装
│  ├─ defaultRuleSet.js              # 人工智能学院默认规则集初始化
│  ├─ applicationSubmission.js       # 申报、材料、提交版本与撤回
│  ├─ auditCalculation.js            # 审核动作、自动触发和分层核算
│  ├─ resultManagement.js            # 统计、导出、公示和公示结果
│  ├─ systemManagement.js            # 学生、用户、批量导入和操作日志
│  ├─ auth.js                        # 登录会话、角色身份和演示账号初始化
│  ├─ scoreImport.js                 # 学委/学院统一上传与自动核算接入
│  └─ xlsxLite.js                    # 项目内置的轻量 xlsx 读写实现
├─ sql/                              # 数据库结构与历史迁移
│  ├─ schema.sql                     # 全量建表脚本；全新初始化使用
│  ├─ 002_audit_calculation_enhancements.sql
│  │                                  # 申报、审核和核算增强迁移
│  ├─ 003_system_result_management.sql
│  │                                  # 结果与系统管理迁移
│  ├─ 004_auth_role_score_import.sql  # 登录会话和角色统一上传迁移
│  └─ migrate-rule-node-aggregate.sql # 旧规则层级合并为 aggregate/item
├─ scripts/                          # Windows PowerShell 运维与验证脚本
│  ├─ start-mysql.ps1                # 创建或启动 MySQL Docker 容器
│  ├─ init-db.ps1                    # 执行全量 schema，重建数据库表
│  ├─ migrate-db.ps1                 # 按文件执行一次历史迁移
│  ├─ start-app.ps1                  # 启动 Node 服务并开放局域网访问
│  ├─ verify-rule-config.ps1         # 规则配置与快照绑定验证
│  ├─ verify-rule-node-model.ps1     # aggregate/item 与节点删除约束验证
│  ├─ verify-default-rule-set.ps1    # 默认规则集完整性验证
│  ├─ verify-application-submission.ps1
│  │                                  # 申报、材料和提交版本验证
│  ├─ verify-audit-calculation.ps1   # 审核与自动核算验证
│  ├─ verify-result-system.ps1       # 统计、公示、导出和系统管理验证
│  └─ verify-year-force-delete.ps1   # 最高管理员彻底删除学年验证
├─ docs/                             # 需求、设计与说明文档
│  ├─ README.md                      # 文档索引
│  ├─ 2026-07-12上午修改记录.md        # 本次提交的详细修改说明
│  ├─ 数据库设计.md                   # 当前数据库设计与上层 SQL
│  ├─ 学年规则管理机制说明.md           # 面向非技术用户的学年/规则/快照说明
│  ├─ 核心业务流分析与功能设定.md       # 核心业务流与功能边界
│  ├─ 接口设计.md                     # 接口设计资料
│  ├─ 0709_2设计文档_综合测评自动算分系统.pdf
│  └─ 甲方的需求文档.docx
├─ uploads/applications/             # 运行时上传的申报材料；不提交 Git
├─ tmp/                              # 本地日志和临时文件；不提交 Git
└─ tools/                            # 本地辅助工具；不提交 Git
```

`node_modules/`、`.pnpm-store/`、`.git/` 等依赖或版本控制目录未在上面的业务目录树中展开。

## 环境要求

### 你需要安装的软件

| 软件 | 用途 | 下载 |
|------|------|------|
| **Docker Desktop** | 运行 MySQL 数据库 | https://www.docker.com/products/docker-desktop |
| **Node.js** 20+ | 运行后端服务 | https://nodejs.org（推荐 LTS 版本） |
| **Git**（可选） | 克隆代码 | https://git-scm.com |

> **不需要手动配置路径！** 所有脚本通过 `scripts/common.ps1` 自动查找 Node.js 和 Docker，支持常见安装位置（包括 VS Code 内置的 Codex 运行时、nvm、fnm 等）。

### 数据库配置

脚本会自动创建 MySQL Docker 容器，默认配置如下（无需手动修改）：

```text
容器名：bnuai-zongce-mysql
端口映射：本机 3307 → 容器 3306
数据库：bnuai_zongce
应用用户：zongce / zongce123
root 密码：root123
```

如需自定义，可在运行脚本前设置环境变量（参考 `.env.example`）。

---

## 给朋友的快速上手指南

以下步骤从零开始，大约 **10 分钟** 即可跑起来。

### 第一步：克隆代码

```powershell
git clone <仓库地址>
cd BNUAI_zongce
```

如果你拿到的是压缩包，解压后进入该目录即可。

### 第二步：安装依赖

```powershell
npm install
# 或者
pnpm install
```

### 第三步：启动 MySQL 数据库

> **前提：Docker Desktop 必须正在运行**（任务栏有 Docker 图标且状态为 "Engine running"）。

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-mysql.ps1
```

首次运行会自动下载 MySQL 镜像（约 500 MB），之后启动只需几秒。看到 `MySQL is ready on 127.0.0.1:3307` 即成功。

### 第四步：初始化数据库表

```powershell
powershell -ExecutionPolicy Bypass -File scripts\init-db.ps1
```

看到 `Database schema initialized.` 即成功。

> ⚠️ **注意**：此命令会清空并重建所有表，仅在首次安装时执行。

### 第五步：启动应用

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-app.ps1
```

看到 `Rule config demo is running at http://0.0.0.0:5173` 即成功。

### 第六步：打开浏览器

- 本机访问：**http://localhost:5173**
- 局域网内的朋友访问：**http://\<你的电脑IP\>:5173**（如 `http://192.168.1.100:5173`）

### 第七步：初始化默认规则集

使用以下演示账号登录，初始密码均为 `123456`：

| 角色 | 账号 |
|---|---|
| 学生 | `student001` |
| 学委 | `committee001` |
| 学院管理员 | `admin001` |
| 最高管理员 | `rootadmin`（从学院管理员入口登录） |

管理员登录后：
1. 点击侧边栏「规则集与版本」
2. 点击「初始化默认规则集」
3. 系统会自动创建学年、规则树和示例申报数据

现在就可以体验完整的申报→审核→核算→结果流程了！

---

## 环境要求（详细）

- **操作系统**：Windows 10/11（PowerShell 5.1+）
- **Docker Desktop**：用于运行 MySQL 8.4 容器
- **Node.js**：20 或更高版本
- 不需要手动安装 MySQL —— 启动脚本自动管理 Docker 容器

### 路径自动检测

所有 `.ps1` 脚本通过 `scripts/common.ps1` 自动查找 `node.exe` 和 `docker.exe`，无需手动配置环境变量。搜索顺序：

1. 系统 PATH（`Get-Command`）
2. 常见安装目录（`Program Files`、`AppData`）
3. VS Code Codex 运行时（`~/.cache/codex-runtimes`）
4. Node.js 版本管理器（nvm-windows、fnm）

如果你使用的是非标准安装路径，只需确保 `node` 和 `docker` 命令可在终端中直接执行（即已加入 PATH）即可。

### 自定义数据库配置

默认配置适用于本地 Docker 环境：

```text
host: 127.0.0.1
port: 3307
database: bnuai_zongce
user: zongce
password: zongce123
```

可通过环境变量覆盖（参考 `.env.example`），当前程序直接读取进程环境变量。

---

## 已有数据库迁移

历史迁移是一次性操作。执行前应备份数据库，并确认目标迁移尚未应用。

```powershell
powershell -ExecutionPolicy Bypass -File scripts\migrate-db.ps1 -MigrationFile 002_audit_calculation_enhancements.sql
powershell -ExecutionPolicy Bypass -File scripts\migrate-db.ps1 -MigrationFile 003_system_result_management.sql
powershell -ExecutionPolicy Bypass -File scripts\migrate-db.ps1 -MigrationFile 004_auth_role_score_import.sql
powershell -ExecutionPolicy Bypass -File scripts\migrate-db.ps1 -MigrationFile migrate-rule-node-aggregate.sql
```

全新数据库不需要执行这些迁移，`schema.sql` 已包含最终结构。

## 功能模块

| 页面 | 主要功能 |
|---|---|
| 规则集与版本 | 创建和选择规则集、创建和发布版本、删除或归档规则集 |
| 创建节点 | 创建汇总节点或规则项，维护父子关系和汇总规则 |
| 节点配置 | 配置计分、申报字段、材料、审核、适用范围和团体分配；删除未被引用节点 |
| 学年管理 | 创建学年、绑定规则快照、归档或由最高管理员彻底删除 |
| 申报 | 动态生成申报表单、保存草稿、上传材料和提交审核 |
| 审核 | 查询审核队列、通过、退回或驳回，最终通过后自动核算 |
| 统一上传 | 学委上传本行政班、学院管理员上传全院 xlsx；逐行留痕并自动核算 |
| 核算 | 查看核算批次、学生总分和节点级得分明细 |
| 结果 | 按年级/专业/行政班统计、导出、公示和结束公示 |
| 系统 | 学生管理、用户管理、xlsx 导入、模板下载和操作日志 |

## 自动验证

所有验证脚本都会连接本机测试数据库并写入测试数据，其中大部分脚本会自行清理临时规则集和学年。建议只在开发环境运行。

```powershell
powershell -ExecutionPolicy Bypass -File scripts\verify-rule-node-model.ps1
powershell -ExecutionPolicy Bypass -File scripts\verify-default-rule-set.ps1
powershell -ExecutionPolicy Bypass -File scripts\verify-rule-config.ps1
powershell -ExecutionPolicy Bypass -File scripts\verify-application-submission.ps1
powershell -ExecutionPolicy Bypass -File scripts\verify-audit-calculation.ps1
powershell -ExecutionPolicy Bypass -File scripts\verify-result-system.ps1
powershell -ExecutionPolicy Bypass -File scripts\verify-year-force-delete.ps1
```

## 权限说明

当前版本已实现数据库登录会话和四类角色工作台。统一上传及彻底删除学年从会话取得操作者身份并在后端校验角色；`X-Operator-Id` 只为旧验证脚本保留，不应在新前端中使用。正式部署时仍应将本地账号登录替换为学校统一身份认证，并启用 HTTPS、密码强度策略和会话定期清理。

## 常见问题

### 脚本报错 "Cannot find node.exe"
Node.js 未安装或未加入 PATH。请从 https://nodejs.org 下载安装，安装时勾选 "Add to PATH"。安装后重新打开终端再试。

### 脚本报错 "Cannot find docker.exe"
Docker Desktop 未安装或未运行。请从 https://www.docker.com/products/docker-desktop 下载安装并启动。确保任务栏 Docker 图标状态为 "Engine running"。

### MySQL 容器启动失败
检查 Docker Desktop 是否正在运行，以及 3307 端口是否被占用：
```powershell
docker ps -a
netstat -ano | findstr 3307
```

### 应用启动后无法访问
- 确认看到的输出是 `Rule config demo is running at http://0.0.0.0:5173`
- 检查 Windows 防火墙是否允许 Node.js 入站连接
- 如果本机可用但局域网不可用，检查是否在同一网络段

### 数据库连接失败
确认 MySQL 容器在运行：
```powershell
docker ps --filter "name=bnuai-zongce-mysql"
```
如果没有运行，重新执行 `scripts/start-mysql.ps1`。

### 如何彻底重置
```powershell
# 1. 停止并删除容器（清空所有数据）
docker rm -f bnuai-zongce-mysql

# 2. 重新启动
powershell -ExecutionPolicy Bypass -File scripts\start-mysql.ps1
powershell -ExecutionPolicy Bypass -File scripts\init-db.ps1
powershell -ExecutionPolicy Bypass -File scripts\start-app.ps1
```

## 设计文档

设计资料索引见 [docs/README.md](docs/README.md)，数据库结构和常用查询以 [docs/数据库设计.md](docs/数据库设计.md) 为准。
