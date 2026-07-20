# 综合测评自动算分系统

本项目是面向学院本科生综合测评业务的可运行系统，覆盖角色登录、规则集与学年管理、学生申报、材料上传、AI 辅助审核、人工审核、统一导入、自动核算、结果统计与公示，以及学生和用户管理。

系统采用 Node.js、MySQL 8.4 和原生 HTML/CSS/JavaScript。前端静态资源和后端 API 由同一个 Node.js 服务提供。

## 核心业务约定

- 规则由“规则集 → 规则版本 → 规则树”表达。
- 规则树节点分为 `aggregate`（汇总节点）和 `item`（规则项）。
- 学年绑定规则快照，申报、审核和核算均保留对应学年与快照。
- AI 审核提供材料识别和姓名匹配结果，最终结论仍由人工审核确定。
- 最终审核通过后自动核算；规则快照变化且已有通过申报时自动重算。
- 有业务数据的学年默认只能归档；最高管理员二次确认后可以彻底删除。

## 目录结构

```text
BNUAI-zongce/
├─ Dockerfile                       # Node.js 应用镜像
├─ docker-compose.yml               # MySQL 与应用编排
├─ .dockerignore                    # Docker 构建排除规则
├─ .env.example                     # 环境变量示例
├─ README.md                        # 项目入口和部署说明
├─ package.json                     # Node.js 依赖与启动命令
├─ public/                          # 浏览器端资源
│  ├─ index.html
│  ├─ app.js
│  └─ styles.css
├─ src/                             # Node.js 后端
│  ├─ server.js                     # HTTP 服务与 API 入口
│  ├─ db.js                         # MySQL 连接池
│  ├─ auth.js                       # 登录与角色
│  ├─ aiAudit.js                    # AI 材料辅助审核
│  ├─ defaultRuleSet.js             # 默认规则集
│  ├─ applicationSubmission.js      # 申报与材料
│  ├─ auditCalculation.js           # 审核与核算
│  ├─ resultManagement.js           # 统计、公示和导出
│  ├─ systemManagement.js           # 学生、用户与日志
│  ├─ scoreImport.js                # 学委/学院统一上传
│  └─ xlsxLite.js                   # xlsx 读写
├─ sql/                             # 数据库结构和迁移文件
├─ scripts/                         # PowerShell 运维和验证脚本
├─ docs/                            # 使用说明、问题报告和设计资料
├─ uploads/applications/            # 运行时上传材料
├─ tmp/                             # 本地日志和临时文件
└─ tools/                           # 本地辅助工具
```

## Docker Compose 部署

### 环境要求

- Docker Desktop，状态为 `Engine running`
- Git（克隆仓库时需要）

使用 Docker 完整部署时，不需要另外安装 Node.js 或 MySQL。

### 启动项目

```powershell
git clone https://github.com/lkjuni/BNUAI-zongce.git
cd BNUAI-zongce
docker compose up -d --build
```

首次构建需要下载基础镜像和安装依赖，请等待命令完成。

查看运行状态：

```powershell
docker compose ps
```

查看日志：

```powershell
docker compose logs -f db app
```

启动成功后访问：

- 本机：<http://localhost:5173>
- 局域网：`http://<部署电脑IP>:5173`

### 配置 AI API Key

在 `docker-compose.yml` 同级目录创建本机 `.env` 文件；如果文件已经存在，不要覆盖：

```powershell
if (!(Test-Path .env)) {
  Copy-Item .env.example .env
}
notepad .env
```

填写以下变量：

```dotenv
AI_API_KEY=你的新APIKey
AI_API_BASE_URL=https://ws-uwiff5b8ww2vs5zv.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
AI_MODEL=qwen-vl-max
```

保存后重新构建应用容器：

```powershell
docker compose up -d --build --force-recreate app
```

可以使用以下命令确认容器已经收到密钥；该命令不会显示密钥内容：

```powershell
docker compose exec app sh -lc 'test -n "$AI_API_KEY" && echo "API Key 已配置" || echo "API Key 未配置"'
```

`.env` 已被 Git 忽略。不要把真实密钥写入源码、README 或提交到 Git；已经暴露的旧密钥应先在云服务控制台撤销，再生成新密钥。

### 默认账号

所有默认账号的初始密码均为 `123456`。

| 角色 | 账号 | 登录入口 |
|---|---|---|
| 学生 | `student001` | 学生 |
| 学委 | `committee001` | 学委 |
| 学院管理员 | `admin001` | 学院管理员 |
| 最高管理员 | `rootadmin` | 学院管理员 |

### 初始化默认规则集

使用学院管理员或最高管理员账号登录后：

1. 打开“规则集与版本”。
2. 点击“初始化默认规则集”。
3. 等待系统创建学年、规则树和示例数据。

完成后即可体验申报、材料上传、审核、核算和结果公示流程。

### 常用命令

```powershell
# 后台启动或重新构建
docker compose up -d --build

# 查看容器状态
docker compose ps

# 查看最近 200 行日志
docker compose logs --tail 200 db app

# 停止项目
docker compose down
```

## 本地 Node.js 开发

本地开发需要 Node.js 20+ 和可用的 MySQL 8.4 数据库。

```powershell
npm install
npm start
```

默认访问地址为 <http://localhost:5173>。数据库连接参数可通过进程环境变量覆盖，变量名称见 `.env.example`。

## 功能模块

| 页面 | 主要功能 |
|---|---|
| 规则集与版本 | 创建规则集、维护版本、发布和归档 |
| 创建节点 | 创建汇总节点或规则项，维护父子关系 |
| 节点配置 | 配置计分、表单、材料、审核与适用范围 |
| 学年管理 | 创建学年、绑定规则快照、归档或彻底删除 |
| 申报 | 动态表单、草稿、材料上传、提交和撤回 |
| 审核 | AI 辅助结果、人工通过、退回或驳回 |
| 统一上传 | 学委上传本班、学院管理员上传全院 xlsx |
| 核算 | 核算批次、学生总分和节点级明细 |
| 结果 | 统计、导出、公示和结束公示 |
| 系统 | 学生、用户、xlsx 导入和操作日志 |

## 自动验证

验证脚本会连接测试数据库并写入测试数据，只应在开发环境运行。

```powershell
powershell -ExecutionPolicy Bypass -File scripts\verify-rule-node-model.ps1
powershell -ExecutionPolicy Bypass -File scripts\verify-default-rule-set.ps1
powershell -ExecutionPolicy Bypass -File scripts\verify-rule-config.ps1
powershell -ExecutionPolicy Bypass -File scripts\verify-application-submission.ps1
powershell -ExecutionPolicy Bypass -File scripts\verify-audit-calculation.ps1
powershell -ExecutionPolicy Bypass -File scripts\verify-result-system.ps1
powershell -ExecutionPolicy Bypass -File scripts\verify-year-force-delete.ps1
```

## 文档

- [文档索引](docs/README.md)
- [系统使用说明](docs/使用说明.md)
- [Docker 首次部署默认账号无法登录问题报告](docs/07-20bug报告：docker部署后无法登陆默认用户.md)
- [数据库设计](docs/数据库设计.md)
- [核心业务流分析与功能设定](docs/核心业务流分析与功能设定.md)
- [学年规则管理机制说明](docs/学年规则管理机制说明.md)

当文档与代码不一致时，以 `sql/schema.sql`、`src/` 和实际验证结果为准。
