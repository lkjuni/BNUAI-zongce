# 综合测评自动算分系统

本目录用于存放综合测评自动算分系统的设计资料、数据库脚本和后续实现文件。

## 目录结构

```text
.
├─ docs/
│  └─ database-design.md        # 学年、规则、申报、核算、公示数据库设计
├─ sql/
│  └─ schema.sql                # MySQL 8.0 建库建表脚本
└─ tmp/                         # 临时文件
```

## 当前设计重点

数据库设计采用“学年批次 + 规则版本 + 学年规则快照 + 申报审核 + 分层核算 + 公示复查”的结构。

核心原则：

- 规则集模板可编辑，发布后的规则版本原则上只读。
- 学年绑定规则快照，学生申报、审核、核算和公示均基于该快照。
- 规则只能在系统预设框架内配置，不支持任意自然语言规则直接参与自动计算。
- 核算结果按申报记录、规则节点、最终总分分层保存，便于解释、复查和重算。

## 本地运行

1. 启动 MySQL 容器：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-mysql.ps1
```

2. 初始化数据库表：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\init-db.ps1
```

3. 安装依赖并启动规则配置验证系统：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-app.ps1
```

访问地址：

```text
http://localhost:5173
```

如果 5173 已被占用，可指定其他端口：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-app.ps1 -Port 5174
```

默认数据库连接：

```text
host: 127.0.0.1
port: 3307
database: bnuai_zongce
user: zongce
password: zongce123
```

## 自动验证

可运行以下脚本验证规则配置链路：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\verify-rule-config.ps1
```

验证内容包括：

- 创建规则集与规则版本
- 创建规则树节点
- 配置计分规则
- 配置申报字段
- 配置材料要求
- 配置审核要求
- 配置适用范围
- 配置团体分配规则
- 绑定学年规则快照

审核与智能核算链路验证：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\verify-audit-calculation.ps1
```

该验证会执行：

- 生成基于学年规则快照的学生申报样例
- 将申报记录作为审核最小颗粒度进行审核
- 审核通过后自动触发核算批次
- 先计算单项申报基础分
- 再按规则树进行分类汇总、封顶、取最高和总分排名
- 查询学生核算明细、核算提醒和错误记录

系统仍保留“手动重算”按钮，用于管理员复核或异常恢复；正常业务流中，核算由审核通过、规则快照变更等事件触发。

申报与材料提交链路验证：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\verify-application-submission.ps1
```

该验证会执行：
- 查询学年规则快照中的可申报规则项
- 按规则项动态字段保存学生申报草稿
- 上传必需证明材料并持久化到 `uploads/applications`
- 提交申报并生成 `application_revision`
- 确认申报进入审核队列，且提交动作本身不会触发核算
- 审核通过后确认自动触发核算

## 学年、规则与快照机制说明

面向非技术用户的说明文档已写入：

```text
docs/year-rule-snapshot-mechanism.md
```

该文档解释：
- 学年、规则集、规则版本、规则快照分别是什么
- 为什么学生填报和核算要基于“学年规则快照”
- 规则树如何理解
- 规则调整后为什么要留痕和重新核算
- 学生申报、审核、核算、公示之间的关系

## 数据库迁移

如果是在已有数据库上继续开发，需要执行新增表迁移：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\migrate-db.ps1
```

新增内容包括：
- 学生基础信息表
- 系统用户表
- 系统操作日志表

## 结果与系统管理验证

```powershell
powershell -ExecutionPolicy Bypass -File scripts\verify-result-system.ps1
```

该验证会执行：
- 创建学生与用户
- 下载学生/用户 xlsx 模板
- 查询最新核算结果
- 查询行政班得分汇总
- 导出成绩结果 xlsx
- 发起公示并结束公示
- 查询操作日志

## 局域网访问

服务默认绑定 `0.0.0.0`，允许局域网访问：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-app.ps1 -Port 5173
```

本机访问：

```text
http://localhost:5173
```

局域网访问时，把 `localhost` 换成这台电脑的局域网 IP，例如：

```text
http://192.168.1.23:5173
```
