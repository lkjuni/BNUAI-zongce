# Docker 首次部署默认账号无法登录问题报告

## 1. 问题摘要

项目通过以下命令首次部署后：

```powershell
docker compose up -d --build
```

出现以下现象：

- MySQL 容器显示 `healthy`；
- 应用容器显示 `healthy`；
- 前端页面可以正常打开；
- 数据库业务表已经创建；
- 但所有默认账号均无法登录。

受影响的默认账号包括：

| 角色 | 用户名 | 初始密码 |
|---|---|---|
| 学生 | `student001` | `123456` |
| 学委 | `committee001` | `123456` |
| 学院管理员 | `admin001` | `123456` |
| 最高管理员 | `rootadmin` | `123456` |

问题仅在全新 MySQL 数据卷首次初始化时容易出现。MySQL 已经稳定运行后，单独重启应用通常可以恢复默认账号。

---

## 2. 影响范围

该问题会造成：

- 前端页面可访问，但用户无法登录；
- Docker 状态显示正常，容易误判为账号或前端问题；
- `system_user` 表存在，但其中没有默认账号；
- 管理员无法进入系统执行规则集初始化等后续操作；
- 用户可能误执行 `init-db.ps1`，导致已有数据库表被删除并重建。

---

## 3. 默认账号的创建位置

默认账号不是由 `sql/schema.sql` 创建的。

`schema.sql` 只负责创建：

- `student_profile`
- `system_user`
- `auth_session`
- 其他业务表

默认账号由 `src/auth.js` 中的函数创建：

```js
ensureBootstrapAccounts()
```

该函数会：

1. 查询学号为 `2026001` 的示例学生；
2. 不存在时创建示例学生“张三”；
3. 创建四个默认账号；
4. 将密码 `123456` 计算为 SHA-256 哈希后保存；
5. 使用 `INSERT IGNORE` 避免覆盖已有同名账号。

因此首次部署实际包含两个初始化阶段：

```text
MySQL 容器
→ 初始化数据库并创建业务表

Node.js 应用
→ 创建示例学生和默认账号
```

数据库建表成功，不代表默认账号一定已经创建。

---

## 4. MySQL 首次初始化过程

项目将以下文件挂载到 MySQL 官方初始化目录：

```yaml
volumes:
  - ./sql/schema.sql:/docker-entrypoint-initdb.d/01-schema.sql
  - ./sql/006_ai_audit.sql:/docker-entrypoint-initdb.d/02-ai-audit.sql
```

当 `/var/lib/mysql` 对应的数据卷为空时，MySQL 官方入口脚本会执行：

```text
初始化 MySQL 数据文件
→ 启动临时 MySQL
→ 创建 bnuai_zongce 数据库
→ 创建 zongce 用户
→ 执行 01-schema.sql
→ 执行 02-ai-audit.sql
→ 关闭临时 MySQL
→ 启动正式 MySQL
```

临时 MySQL 和正式 MySQL使用同一个 `/var/lib/mysql` 数据目录，但连接方式不同。

临时 MySQL 的实际日志显示：

```text
Temporary server started
ready for connections
port: 0
socket: /var/run/mysqld/mysql.sock
```

其中 `port: 0` 表示临时 MySQL 没有开放 TCP 3306，只允许数据库容器内部通过 Unix Socket 访问。

正式 MySQL 启动后才监听：

```text
port: 3306
```

---

## 5. 根本原因

### 5.1 健康检查使用了 Unix Socket

原 MySQL 健康检查为：

```yaml
healthcheck:
  test:
    [
      "CMD",
      "mysqladmin",
      "ping",
      "-h",
      "localhost",
      "-u",
      "zongce",
      "-pzongce123"
    ]
```

该命令在 `db` 容器内部执行。

MySQL 客户端使用 `localhost` 时，通常会优先通过 Unix Socket 连接，而不是 TCP。

因此临时 MySQL 虽然没有监听 TCP 3306，但仍然能够通过 Socket 响应：

```text
mysqladmin ping -h localhost
```

Docker 随即把 `db` 容器标记为 `healthy`。

### 5.2 应用使用 TCP 连接

应用运行在另一个容器中，数据库配置为：

```text
DB_HOST=db
DB_PORT=3306
```

应用必须通过 Docker 网络和 TCP 3306 连接 MySQL，不能访问 `db` 容器内部的 Unix Socket。

于是出现了连接判断不一致：

```text
Docker 健康检查：
Unix Socket 可以连接
→ 判断 MySQL healthy

Node.js 应用：
TCP 3306 尚未监听
→ ECONNREFUSED
```

### 5.3 Compose 提前启动应用

应用配置为：

```yaml
depends_on:
  db:
    condition: service_healthy
```

当 Socket 健康检查通过后，Compose 立即启动应用。

但此时可能仍处于以下阶段：

```text
临时 MySQL 正在运行
或者
临时 MySQL 正在关闭
或者
正式 MySQL 尚未开始监听 3306
```

因此应用连接数据库时收到：

```text
connect ECONNREFUSED db:3306
```

### 5.4 原应用只尝试一次

原启动逻辑类似：

```js
server.listen(port, host, async () => {
  try {
    await ensureBootstrapAccounts();
  } catch (error) {
    console.error(
      "Server started, but database connection failed:",
      error.message
    );
  }
});
```

这里虽然使用了 `await`，但它只等待这一次数据库操作成功或失败，不会自动重试。

连接失败后：

- 异常被 `catch` 捕获；
- 只输出错误日志；
- 应用进程不会退出；
- HTTP 服务已经监听 `5173`；
- 默认账号初始化不会再次执行。

最终形成以下状态：

```text
数据库表：创建成功
默认账号：创建失败
前端页面：可以打开
应用容器：显示 healthy
登录：失败
```

---

## 6. 实际复现证据

删除项目容器和数据卷后，从空数据卷重新执行：

```powershell
docker compose up -d --build
```

MySQL 日志确认两份 SQL 均已执行：

```text
running /docker-entrypoint-initdb.d/01-schema.sql
running /docker-entrypoint-initdb.d/02-ai-audit.sql
MySQL init process done
```

数据库检查结果：

```text
tables=42
system_users=0
students=0
```

说明：

- 数据库初始化脚本执行成功；
- 42 张业务表已经创建；
- 默认账号和示例学生没有创建。

应用日志为：

```text
Server started, but database connection failed:
connect ECONNREFUSED 172.18.0.2:3306
```

因此可以确认：

> 问题不是建表脚本没有运行，而是默认账号初始化时，应用无法通过 TCP 连接尚未完全启动的正式 MySQL。

---

## 7. 已实施的代码修复

修改了 `src/server.js` 的启动逻辑。

### 7.1 增加数据库连接重试

新增配置：

```js
const databaseStartupAttempts = 30;
const databaseRetryDelayMs = 1000;
```

应用数据库初始化失败后：

```text
等待 1 秒
→ 再次尝试
→ 最多尝试 30 次
```

### 7.2 只有初始化成功后才监听 HTTP

原启动顺序：

```text
先监听 5173
→ 再创建默认账号
```

修改后的启动顺序：

```text
连接数据库
→ 创建默认账号
→ 查询数据库表数量
→ 确认全部成功
→ 开始监听 5173
```

核心逻辑为：

```js
async function initializeDatabase() {
  let lastError;

  for (
    let attempt = 1;
    attempt <= databaseStartupAttempts;
    attempt += 1
  ) {
    try {
      await ensureBootstrapAccounts();

      const [tableCount] = await query(
        "SELECT COUNT(*) AS count " +
        "FROM information_schema.tables " +
        "WHERE table_schema = DATABASE()"
      );

      return tableCount;
    } catch (error) {
      lastError = error;

      if (attempt === databaseStartupAttempts) {
        break;
      }

      await delay(databaseRetryDelayMs);
    }
  }

  throw lastError;
}
```

### 7.3 持续失败时主动退出

如果连续 30 次仍不能连接数据库，应用会：

```text
关闭数据库连接池
→ process.exit(1)
→ 容器进程退出
→ Docker 根据 restart: unless-stopped 重启应用
```

这样可以避免应用在数据库不可用时继续处于“假正常”状态。

---

## 8. 修复后的验证结果

再次删除所有项目容器和数据卷，重新执行全新部署。

应用日志显示：

```text
Database is not ready (1/30):
connect ECONNREFUSED 172.18.0.2:3306

Database is not ready (2/30):
connect ECONNREFUSED 172.18.0.2:3306

Rule config demo is running at http://0.0.0.0:5173
Connected to MySQL with 42 tables.
```

说明应用经历了：

```text
第一次 TCP 连接失败
→ 等待 1 秒
→ 第二次 TCP 连接失败
→ 等待 1 秒
→ 正式 MySQL 开始监听 3306
→ 创建默认账号成功
→ 启动 HTTP 服务
```

数据库检查结果：

```text
student001    student          active
committee001  class_committee  active
admin001      college_admin    active
rootadmin     super_admin      active
```

四个账号的密码哈希均与 `123456` 相符。

登录接口实际验证：

```text
请求账号：student001
请求密码：123456
HTTP 状态：200
返回结果：登录成功
```

整个过程没有人工重启应用。

---

## 9. 已实施的 Docker 健康检查修复

应用内部重试已经解决默认账号创建失败的问题。

为了从 Compose 启动顺序上消除误判，本次同时将 MySQL 健康检查改成强制 TCP，并从容器环境变量读取业务账号：

```yaml
healthcheck:
  test: [
    "CMD-SHELL",
    "mysqladmin ping --protocol=TCP -h 127.0.0.1 -u\"$${MYSQL_USER}\" -p\"$${MYSQL_PASSWORD}\" --silent"
  ]
  interval: 10s
  timeout: 5s
  retries: 10
  start_period: 30s
```

修改后的含义是：

```text
临时 MySQL：
只提供 Socket，不提供 TCP
→ 健康检查失败

正式 MySQL：
监听 TCP 3306
→ 健康检查成功
→ Compose 启动 app
```

同时保留应用内部重试机制，形成两层保护：

```text
第一层：Compose 强制 TCP 健康检查
第二层：应用数据库连接和默认账号初始化重试
```

健康检查负责正常的容器启动顺序，应用重试负责处理短暂网络抖动、数据库重启及非 Docker 部署环境。

---

## 10. 为什么不能使用固定延迟代替

可以在 Dockerfile 中增加：

```dockerfile
CMD ["sh", "-c", "sleep 15 && node src/server.js"]
```

但不推荐，因为固定时间无法适应不同机器：

- 性能好的电脑可能只需数秒；
- 性能较差的电脑可能超过 15 秒；
- 数据库故障时，等待结束后仍然连接失败；
- 无法确认表和默认账号是否真正初始化成功。

正确方式应基于实际可用条件：

```text
TCP 连接成功
并且
业务表存在
并且
默认账号创建成功
```

而不是猜测数据库需要多少秒启动。

---

## 11. 已受影响部署的恢复方式

如果数据库中已经有 42 张表，但默认账号数量为 0：

```text
不需要删除数据库卷
不需要重新执行 schema.sql
不需要运行 init-db.ps1
```

使用修复后的代码重新构建应用即可：

```powershell
docker compose up -d --build
```

应用启动后会通过 `INSERT IGNORE` 补建缺失的默认账号。

临时恢复方式是：

```powershell
docker compose restart app
```

但旧代码在下一次全新部署时仍可能再次出现问题，因此应使用修复后的代码。

---

## 12. 关于 `init-db.ps1` 的风险

`init-db.ps1` 会主动把 `schema.sql` 复制到 MySQL 容器并执行。

而 `schema.sql` 包含：

```sql
DROP TABLE IF EXISTS ...
```

因此执行 `init-db.ps1` 会：

```text
删除已有业务表
→ 重新创建表
→ 原有业务数据丢失
```

它不能作为默认账号无法登录的常规修复手段。

Compose 在空数据卷首次启动时自动执行同一份 `schema.sql`，但因为当时数据库本来就是空的，所以不会损失已有数据。

---

## 13. 最终结论

本次问题由两个缺陷共同导致：

1. MySQL 健康检查通过 `localhost` 使用 Unix Socket，临时 MySQL 尚未开放 TCP 3306 时就被误判为健康；
2. Node.js 应用创建默认账号失败后没有重试，并且 HTTP 服务仍然继续运行。

因此出现：

```text
表结构完整
默认账号为空
容器显示健康
前端可以打开
用户无法登录
```

已实施的解决方案是：

```text
应用连接数据库失败后自动重试
→ 默认账号创建成功后才启动 HTTP 服务
→ 持续失败则退出并由 Docker 重启
```

MySQL 健康检查也已改为强制 TCP，从启动顺序上避免临时 MySQL 被误判为正式可用。

最终推荐方案：

```text
TCP 健康检查
+
应用内部数据库重试
+
默认账号初始化成功后再监听 HTTP
```

该组合能够同时覆盖：

- MySQL 首次初始化；
- 临时服务器与正式服务器切换；
- Docker 网络短暂不可用；
- MySQL 容器重启；
- 直接运行 Node.js 的非 Docker 环境。

---

## 14. 2026-07-20 提交前隔离回归

为避免使用残留容器和旧数据，本次使用独立容器、端口和全新数据卷重新验证：

```text
MySQL 容器：zongce-mysql-codex-test
应用容器：zongce-app-codex-test
MySQL 端口：13307
应用端口：15173
```

验证结果：

```text
MySQL：healthy
应用：healthy
数据库表数量：42
前端 HTTP 状态：200
```

MySQL 日志确认：

```text
执行 01-schema.sql
执行 02-ai-audit.sql
关闭临时 MySQL
正式 MySQL 在 TCP 3306 启动
```

四个默认账号均使用初始密码 `123456` 登录成功：

```text
student001
committee001
admin001
rootadmin
```

同时使用只含虚构示例学生“张三”的合成图片完成 AI 审核回归：

```text
模型：qwen-vl-max
审核状态：completed
姓名匹配：成功
```

本次回归证明，全新 Docker 部署、默认账号登录以及 AI 辅助审核链路均可正常工作。
