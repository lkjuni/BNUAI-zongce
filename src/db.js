import mysql from "mysql2/promise";

// 所有业务模块共享连接池，避免每个接口都创建短生命周期的 MySQL 连接。
// 连接配置优先读取进程环境变量，未配置时使用本地 Docker 验证环境的默认值。

const config = {
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 3307),
  user: process.env.DB_USER || "zongce",
  password: process.env.DB_PASSWORD || "zongce123",
  database: process.env.DB_NAME || "bnuai_zongce",
  waitForConnections: true,
  connectionLimit: 10,
  namedPlaceholders: true,
  charset: "utf8mb4"
};

export const pool = mysql.createPool(config);

export async function query(sql, params = {}) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

export async function transaction(work) {
  // 跨多个申报表或成绩表的业务操作必须整体提交或整体回滚。
  // 回调使用当前事务独占的数据库连接。
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export function jsonParam(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}
