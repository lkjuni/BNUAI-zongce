import mysql from "mysql2/promise";

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

