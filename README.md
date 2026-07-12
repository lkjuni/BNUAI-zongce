# 综合测评自动算分系统

本项目是面向学院本科生综合测评业务的可运行原型，覆盖规则集与学年管理、学生申报与材料提交、审核、自动核算、结果统计与公示，以及学生和用户管理。

系统当前采用原生 Node.js HTTP 服务、MySQL 8.4 和原生 HTML/CSS/JavaScript。前后端由同一个 Node 进程提供，适合验证数据库模型和完整业务链路。

## 核心业务约定

- 规则由“规则集 → 规则版本 → 规则树”表达。
- 规则树节点只分为 `aggregate`（汇总节点）和 `item`（规则项）。模块、分类和子分类由父子关系自然表达。
- 学年绑定规则快照，申报、审核和核算都保留对应的学年与快照信息。
- 一条 `application_record` 是申报和审核的最小颗粒度。
- 审核最终通过后自动核算；规则快照变化且已有通过申报时自动重算。
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
│  └─ xlsxLite.js                    # 项目内置的轻量 xlsx 读写实现
├─ sql/                              # 数据库结构与历史迁移
│  ├─ schema.sql                     # 全量建表脚本；全新初始化使用
│  ├─ 002_audit_calculation_enhancements.sql
│  │                                  # 申报、审核和核算增强迁移
│  ├─ 003_system_result_management.sql
│  │                                  # 结果与系统管理迁移
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

- Windows PowerShell 5.1 或更高版本
- Docker Desktop
- Node.js 20 或更高版本
- MySQL 8.4 Docker 镜像，由启动脚本自动创建

默认数据库配置：

```text
host: 127.0.0.1
port: 3307
database: bnuai_zongce
user: zongce
password: zongce123
```

可通过 `.env.example` 查看支持的环境变量。当前程序直接读取进程环境变量，不会自动加载 `.env` 文件。

## 快速启动

### 1. 启动 MySQL

先启动 Docker Desktop，然后执行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-mysql.ps1
```

脚本会创建或启动 `bnuai-zongce-mysql` 容器，并将容器 3306 端口映射到本机 3307。

### 2. 初始化全新数据库

```powershell
powershell -ExecutionPolicy Bypass -File scripts\init-db.ps1
```

注意：`sql/schema.sql` 会删除并重新创建业务表。只有全新安装或明确需要清空测试数据时才能执行，已有业务数据时应使用迁移脚本。

### 3. 启动应用

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-app.ps1
```

默认访问地址：

- 本机：`http://localhost:5173`
- 局域网：`http://<本机局域网IP>:5173`

指定端口或监听地址：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-app.ps1 -Port 5174 -BindHost 0.0.0.0
```

如果已经安装 Node.js 和 pnpm，也可以执行 `pnpm start`。没有安装 pnpm 时直接使用 `scripts/start-app.ps1`。

## 已有数据库迁移

历史迁移是一次性操作。执行前应备份数据库，并确认目标迁移尚未应用。

```powershell
powershell -ExecutionPolicy Bypass -File scripts\migrate-db.ps1 -MigrationFile 002_audit_calculation_enhancements.sql
powershell -ExecutionPolicy Bypass -File scripts\migrate-db.ps1 -MigrationFile 003_system_result_management.sql
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

当前版本是业务和数据库验证原型，尚未接入正式登录会话。彻底删除学年时，前端提交最高管理员用户 ID，后端根据 `system_user.role = 'super_admin'` 和用户状态再次校验。接入统一身份认证后，应从登录会话取得操作者身份，不能继续信任前端传入的用户 ID。

## 设计文档

设计资料索引见 [docs/README.md](docs/README.md)，数据库结构和常用查询以 [docs/数据库设计.md](docs/数据库设计.md) 为准。
