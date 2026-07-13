import crypto from "node:crypto";
import { query, transaction } from "./db.js";

const SESSION_HOURS = 12;

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function hashPassword(password) {
  return crypto.createHash("sha256").update(String(password || "")).digest("hex");
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function publicUser(row) {
  return {
    id: Number(row.id),
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    relatedStudentId: row.related_student_id ? Number(row.related_student_id) : null,
    studentNo: row.student_no || null,
    studentName: row.student_name || null,
    grade: row.grade || null,
    major: row.major || null,
    className: row.administrative_class || row.class_name || null
  };
}

async function loadUserByToken(token) {
  if (!token) return null;
  const [row] = await query(
    `SELECT u.id, u.username, u.display_name, u.role, u.status, u.related_student_id,
            s.student_no, s.name AS student_name, s.grade, s.major, s.class_name, s.administrative_class
     FROM auth_session a
     JOIN system_user u ON u.id = a.user_id
     LEFT JOIN student_profile s ON s.id = u.related_student_id
     WHERE a.token_hash = :tokenHash
       AND a.revoked_at IS NULL
       AND a.expires_at > NOW()
     LIMIT 1`,
    { tokenHash: hashToken(token) }
  );
  if (!row || row.status !== "active") return null;
  return publicUser(row);
}

async function authenticateRequest(req) {
  const authorization = String(req.headers.authorization || "");
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  const user = await loadUserByToken(token);
  req.authToken = token || null;
  req.authUser = user;
  return user;
}

function requireRoles(req, roles) {
  const user = req.authUser;
  if (!user) throw httpError(401, "请先登录后再执行此操作");
  if (!roles.includes(user.role)) throw httpError(403, "当前账号没有执行此操作的权限");
  return user;
}

async function login(body, req) {
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  const expectedRole = String(body.role || "").trim();
  if (!username || !password) throw httpError(400, "请输入账号和密码");

  const [row] = await query(
    `SELECT u.*, s.student_no, s.name AS student_name, s.grade, s.major, s.class_name, s.administrative_class
     FROM system_user u
     LEFT JOIN student_profile s ON s.id = u.related_student_id
     WHERE u.username = :username
     LIMIT 1`,
    { username }
  );
  if (!row || row.password_hash !== hashPassword(password)) throw httpError(401, "账号或密码错误");
  if (row.status !== "active") throw httpError(403, "账号已停用，请联系管理员");
  const roleMatches = row.role === expectedRole || (expectedRole === "college_admin" && row.role === "super_admin");
  if (expectedRole && !roleMatches) throw httpError(403, "账号角色与所选入口不一致");

  const token = crypto.randomBytes(32).toString("hex");
  await transaction(async (conn) => {
    await conn.execute(`DELETE FROM auth_session WHERE expires_at <= NOW() OR revoked_at IS NOT NULL`);
    await conn.execute(
      `INSERT INTO auth_session (user_id, token_hash, expires_at, ip_address, user_agent)
       VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? HOUR), ?, ?)`,
      [row.id, hashToken(token), SESSION_HOURS, req.socket.remoteAddress || null, String(req.headers["user-agent"] || "").slice(0, 255)]
    );
    await conn.execute(
      `INSERT INTO system_operation_log
       (operator_id, operator_name, module, operation_type, target_type, target_id, operation_detail_json, ip_address)
       VALUES (?, ?, 'auth', 'login', 'user', ?, ?, ?)`,
      [row.id, row.display_name, row.id, JSON.stringify({ role: row.role }), req.socket.remoteAddress || null]
    );
  });
  return { token, expiresIn: SESSION_HOURS * 3600, user: publicUser(row) };
}

async function logout(req) {
  if (req.authToken) {
    await query(`UPDATE auth_session SET revoked_at = NOW() WHERE token_hash = :tokenHash`, { tokenHash: hashToken(req.authToken) });
  }
  return { loggedOut: true };
}

async function changePassword(req, body) {
  const user = requireRoles(req, ["student", "class_committee", "college_admin", "super_admin"]);
  const oldPassword = String(body.oldPassword || body.old_password || "");
  const newPassword = String(body.newPassword || body.new_password || "");
  if (newPassword.length < 6) throw httpError(400, "新密码至少需要 6 位");
  const [row] = await query(`SELECT password_hash FROM system_user WHERE id = :id`, { id: user.id });
  if (!row || row.password_hash !== hashPassword(oldPassword)) throw httpError(400, "原密码不正确");
  await transaction(async (conn) => {
    await conn.execute(`UPDATE system_user SET password_hash = ? WHERE id = ?`, [hashPassword(newPassword), user.id]);
    await conn.execute(`UPDATE auth_session SET revoked_at = NOW() WHERE user_id = ?`, [user.id]);
  });
  return { changed: true };
}

async function handleAuthApi(req, res, context) {
  const { parts, method, ok, readJson } = context;
  const route = parts.join("/");
  if (method === "POST" && route === "api/auth/login") return ok(res, await login(await readJson(req), req), "登录成功");
  if (method === "GET" && route === "api/auth/me") {
    const user = requireRoles(req, ["student", "class_committee", "college_admin", "super_admin"]);
    return ok(res, user);
  }
  if (method === "POST" && route === "api/auth/logout") return ok(res, await logout(req), "已退出登录");
  if (method === "PUT" && route === "api/auth/password") return ok(res, await changePassword(req, await readJson(req)), "密码已修改，请重新登录");
  return false;
}

async function ensureBootstrapAccounts() {
  // 演示环境首次启动时提供四类角色账号；已有同名账号时绝不覆盖密码和资料。
  await transaction(async (conn) => {
    const [studentRows] = await conn.execute(`SELECT id FROM student_profile WHERE student_no = '2026001' LIMIT 1`);
    let studentId = studentRows[0]?.id;
    if (!studentId) {
      const [result] = await conn.execute(
        `INSERT INTO student_profile
         (student_no, name, grade, major, class_name, administrative_class, student_type, status, college_id)
         VALUES ('2026001', '张三', '2026', '人工智能', '人工智能2601班', '人工智能2601班', 'normal', 'active', 1)`
      );
      studentId = result.insertId;
    }
    const accounts = [
      ["student001", "学生示例", "student", studentId],
      ["committee001", "学委示例", "class_committee", studentId],
      ["admin001", "学院管理员", "college_admin", null],
      ["rootadmin", "最高管理员", "super_admin", null]
    ];
    for (const [username, displayName, role, relatedStudentId] of accounts) {
      await conn.execute(
        `INSERT IGNORE INTO system_user
         (username, display_name, password_hash, role, status, related_student_id)
         VALUES (?, ?, ?, ?, 'active', ?)`,
        [username, displayName, hashPassword("123456"), role, relatedStudentId]
      );
    }
  });
}

export { authenticateRequest, ensureBootstrapAccounts, handleAuthApi, hashPassword, requireRoles };
