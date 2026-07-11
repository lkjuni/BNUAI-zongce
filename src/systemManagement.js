import crypto from "node:crypto";
import { query, transaction } from "./db.js";
import { buildXlsx, parseXlsx, rowsToObjects } from "./xlsxLite.js";

function makeError(status, message, details = undefined) {
  const error = new Error(message);
  error.status = status;
  error.details = details;
  return error;
}

function pick(row, keys, fallback = "") {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== "") return String(row[key]).trim();
  }
  return fallback;
}

function hashPassword(password) {
  return crypto.createHash("sha256").update(String(password || "123456")).digest("hex");
}

function xlsxResponse(fileName, rows) {
  const buffer = buildXlsx(rows);
  return {
    fileName,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    contentBase64: buffer.toString("base64")
  };
}

function parseUploadedRows(body) {
  if (Array.isArray(body.rows)) return body.rows;
  const content = body.content_base64 || body.contentBase64;
  if (!content) throw makeError(400, "请上传 xlsx 文件内容");
  const rows = parseXlsx(Buffer.from(content, "base64"));
  return rowsToObjects(rows);
}

async function logOperation(connOrNull, detail) {
  const executor = connOrNull || { execute: (sql, params) => query(sql, params) };
  const params = [
    detail.operatorId || null,
    detail.operatorName || null,
    detail.module,
    detail.operationType,
    detail.targetType || null,
    detail.targetId || null,
    JSON.stringify(detail.operationDetail || {}),
    detail.ipAddress || null
  ];
  await executor.execute(
    `INSERT INTO system_operation_log
     (operator_id, operator_name, module, operation_type, target_type, target_id, operation_detail_json, ip_address)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    params
  );
}

function normalizeStudent(body) {
  const studentNo = body.student_no || body.studentNo;
  const name = body.name;
  if (!studentNo || !name) throw makeError(400, "学号和姓名不能为空");
  return {
    studentNo: String(studentNo).trim(),
    name: String(name).trim(),
    grade: body.grade || null,
    major: body.major || null,
    className: body.class_name || body.className || body.administrative_class || body.administrativeClass || null,
    administrativeClass: body.administrative_class || body.administrativeClass || body.class_name || body.className || null,
    studentType: body.student_type || body.studentType || "normal",
    gender: body.gender || null,
    phone: body.phone || null,
    email: body.email || null,
    status: body.status || "active",
    collegeId: body.college_id || body.collegeId || 1
  };
}

function normalizeStudentImportRow(row) {
  return normalizeStudent({
    studentNo: pick(row, ["student_no", "studentNo", "学号"]),
    name: pick(row, ["name", "姓名"]),
    grade: pick(row, ["grade", "年级"], null),
    major: pick(row, ["major", "专业"], null),
    className: pick(row, ["class_name", "className", "行政班", "班级"], null),
    studentType: pick(row, ["student_type", "studentType", "学生类型"], "normal"),
    gender: pick(row, ["gender", "性别"], null),
    phone: pick(row, ["phone", "手机号", "电话"], null),
    email: pick(row, ["email", "邮箱"], null),
    status: pick(row, ["status", "状态"], "active")
  });
}

async function listStudents(url) {
  const keyword = url.searchParams.get("keyword") || "";
  const grade = url.searchParams.get("grade") || "";
  const major = url.searchParams.get("major") || "";
  const className = url.searchParams.get("className") || url.searchParams.get("class_name") || "";
  const rows = await query(
    `SELECT *
     FROM student_profile
     WHERE (:keyword = '' OR student_no LIKE :keywordLike OR name LIKE :keywordLike)
       AND (:grade = '' OR grade = :grade)
       AND (:major = '' OR major = :major)
       AND (:className = '' OR class_name = :className OR administrative_class = :className)
     ORDER BY grade DESC, major, class_name, student_no
     LIMIT 500`,
    { keyword, keywordLike: `%${keyword}%`, grade, major, className }
  );
  return rows;
}

async function getStudent(studentId) {
  const [student] = await query(`SELECT * FROM student_profile WHERE id = :studentId`, { studentId });
  if (!student) throw makeError(404, "学生不存在");
  const [applications, totals] = await Promise.all([
    query(
      `SELECT a.id, a.academic_year_id, y.name AS academic_year_name, a.title, a.status, n.name AS rule_name, n.code AS rule_code
       FROM application_record a
       JOIN academic_year y ON y.id = a.academic_year_id
       JOIN rule_node n ON n.id = a.rule_node_id
       WHERE a.student_id = :studentId OR a.student_id = :studentNo
       ORDER BY a.created_at DESC
       LIMIT 20`,
      { studentId: student.id, studentNo: Number(student.student_no) || 0 }
    ),
    query(
      `SELECT t.*, y.name AS academic_year_name
       FROM score_total_result t
       JOIN academic_year y ON y.id = t.academic_year_id
       WHERE t.student_id = :studentId OR t.student_id = :studentNo
       ORDER BY t.created_at DESC
       LIMIT 20`,
      { studentId: student.id, studentNo: Number(student.student_no) || 0 }
    )
  ]);
  return { ...student, applications, totals };
}

async function createStudent(body, ipAddress) {
  const student = normalizeStudent(body);
  return transaction(async (conn) => {
    const [result] = await conn.execute(
      `INSERT INTO student_profile
       (student_no, name, grade, major, class_name, administrative_class, student_type, gender, phone, email, status, college_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        student.studentNo,
        student.name,
        student.grade,
        student.major,
        student.className,
        student.administrativeClass,
        student.studentType,
        student.gender,
        student.phone,
        student.email,
        student.status,
        student.collegeId
      ]
    );
    await logOperation(conn, {
      module: "system",
      operationType: "create_student",
      targetType: "student",
      targetId: result.insertId,
      operationDetail: student,
      ipAddress
    });
    return { id: result.insertId };
  });
}

async function updateStudent(studentId, body, ipAddress) {
  const student = normalizeStudent(body);
  await transaction(async (conn) => {
    await conn.execute(
      `UPDATE student_profile
       SET student_no = ?, name = ?, grade = ?, major = ?, class_name = ?, administrative_class = ?,
           student_type = ?, gender = ?, phone = ?, email = ?, status = ?, college_id = ?
       WHERE id = ?`,
      [
        student.studentNo,
        student.name,
        student.grade,
        student.major,
        student.className,
        student.administrativeClass,
        student.studentType,
        student.gender,
        student.phone,
        student.email,
        student.status,
        student.collegeId,
        studentId
      ]
    );
    await logOperation(conn, {
      module: "system",
      operationType: "update_student",
      targetType: "student",
      targetId: studentId,
      operationDetail: student,
      ipAddress
    });
  });
  return getStudent(studentId);
}

async function importStudents(body, ipAddress) {
  const rows = parseUploadedRows(body);
  let success = 0;
  const errors = [];
  await transaction(async (conn) => {
    for (let index = 0; index < rows.length; index++) {
      try {
        const student = normalizeStudentImportRow(rows[index]);
        await conn.execute(
          `INSERT INTO student_profile
           (student_no, name, grade, major, class_name, administrative_class, student_type, gender, phone, email, status, college_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
           ON DUPLICATE KEY UPDATE
             name = VALUES(name),
             grade = VALUES(grade),
             major = VALUES(major),
             class_name = VALUES(class_name),
             administrative_class = VALUES(administrative_class),
             student_type = VALUES(student_type),
             gender = VALUES(gender),
             phone = VALUES(phone),
             email = VALUES(email),
             status = VALUES(status)`,
          [
            student.studentNo,
            student.name,
            student.grade,
            student.major,
            student.className,
            student.administrativeClass,
            student.studentType,
            student.gender,
            student.phone,
            student.email,
            student.status
          ]
        );
        success += 1;
      } catch (error) {
        errors.push({ row: index + 2, message: error.message });
      }
    }
    await logOperation(conn, {
      module: "system",
      operationType: "import_students",
      targetType: "student",
      operationDetail: { success, failed: errors.length },
      ipAddress
    });
  });
  return { success, failed: errors.length, errors };
}

function normalizeUser(body) {
  const username = body.username;
  const displayName = body.display_name || body.displayName || body.name;
  if (!username || !displayName) throw makeError(400, "用户名和显示名称不能为空");
  return {
    username: String(username).trim(),
    displayName: String(displayName).trim(),
    password: body.password || "123456",
    role: body.role || "student",
    status: body.status || "active",
    relatedStudentId: body.related_student_id || body.relatedStudentId || null,
    phone: body.phone || null,
    email: body.email || null
  };
}

function normalizeUserImportRow(row) {
  return normalizeUser({
    username: pick(row, ["username", "用户名", "账号"]),
    displayName: pick(row, ["display_name", "displayName", "姓名", "显示名称"]),
    password: pick(row, ["password", "密码"], "123456"),
    role: pick(row, ["role", "角色"], "student"),
    status: pick(row, ["status", "状态"], "active"),
    phone: pick(row, ["phone", "手机号", "电话"], null),
    email: pick(row, ["email", "邮箱"], null)
  });
}

async function listUsers(url) {
  const keyword = url.searchParams.get("keyword") || "";
  const role = url.searchParams.get("role") || "";
  const status = url.searchParams.get("status") || "";
  return query(
    `SELECT u.id, u.username, u.display_name, u.role, u.status, u.related_student_id,
            u.phone, u.email, u.created_at, u.updated_at, s.student_no, s.name AS student_name
     FROM system_user u
     LEFT JOIN student_profile s ON s.id = u.related_student_id
     WHERE (:keyword = '' OR u.username LIKE :keywordLike OR u.display_name LIKE :keywordLike)
       AND (:role = '' OR u.role = :role)
       AND (:status = '' OR u.status = :status)
     ORDER BY u.created_at DESC, u.id DESC
     LIMIT 500`,
    { keyword, keywordLike: `%${keyword}%`, role, status }
  );
}

async function createUser(body, ipAddress) {
  const user = normalizeUser(body);
  return transaction(async (conn) => {
    const [result] = await conn.execute(
      `INSERT INTO system_user
       (username, display_name, password_hash, role, status, related_student_id, phone, email)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [user.username, user.displayName, hashPassword(user.password), user.role, user.status, user.relatedStudentId, user.phone, user.email]
    );
    await logOperation(conn, {
      module: "system",
      operationType: "create_user",
      targetType: "user",
      targetId: result.insertId,
      operationDetail: { username: user.username, role: user.role, status: user.status },
      ipAddress
    });
    return { id: result.insertId };
  });
}

async function updateUser(userId, body, ipAddress) {
  const user = normalizeUser(body);
  await transaction(async (conn) => {
    await conn.execute(
      `UPDATE system_user
       SET username = ?, display_name = ?, role = ?, status = ?, related_student_id = ?, phone = ?, email = ?
       WHERE id = ?`,
      [user.username, user.displayName, user.role, user.status, user.relatedStudentId, user.phone, user.email, userId]
    );
    await logOperation(conn, {
      module: "system",
      operationType: "update_user",
      targetType: "user",
      targetId: userId,
      operationDetail: { username: user.username, role: user.role, status: user.status },
      ipAddress
    });
  });
  return { id: userId };
}

async function importUsers(body, ipAddress) {
  const rows = parseUploadedRows(body);
  let success = 0;
  const errors = [];
  await transaction(async (conn) => {
    for (let index = 0; index < rows.length; index++) {
      try {
        const user = normalizeUserImportRow(rows[index]);
        await conn.execute(
          `INSERT INTO system_user (username, display_name, password_hash, role, status, phone, email)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             display_name = VALUES(display_name),
             role = VALUES(role),
             status = VALUES(status),
             phone = VALUES(phone),
             email = VALUES(email)`,
          [user.username, user.displayName, hashPassword(user.password), user.role, user.status, user.phone, user.email]
        );
        success += 1;
      } catch (error) {
        errors.push({ row: index + 2, message: error.message });
      }
    }
    await logOperation(conn, {
      module: "system",
      operationType: "import_users",
      targetType: "user",
      operationDetail: { success, failed: errors.length },
      ipAddress
    });
  });
  return { success, failed: errors.length, errors };
}

async function resetPassword(userId, body, ipAddress) {
  const password = body.password || "123456";
  await transaction(async (conn) => {
    await conn.execute(`UPDATE system_user SET password_hash = ? WHERE id = ?`, [hashPassword(password), userId]);
    await logOperation(conn, {
      module: "system",
      operationType: "reset_password",
      targetType: "user",
      targetId: userId,
      operationDetail: {},
      ipAddress
    });
  });
  return { id: userId };
}

async function updateUserStatus(userId, body, ipAddress) {
  const status = body.status || "active";
  await transaction(async (conn) => {
    await conn.execute(`UPDATE system_user SET status = ? WHERE id = ?`, [status, userId]);
    await logOperation(conn, {
      module: "system",
      operationType: "update_user_status",
      targetType: "user",
      targetId: userId,
      operationDetail: { status },
      ipAddress
    });
  });
  return { id: userId, status };
}

async function listLogs(url) {
  const module = url.searchParams.get("module") || "";
  const rows = await query(
    `SELECT *
     FROM system_operation_log
     WHERE (:module = '' OR module = :module)
     ORDER BY created_at DESC, id DESC
     LIMIT 200`,
    { module }
  );
  return rows.map((row) => ({
    ...row,
    operation_detail_json: typeof row.operation_detail_json === "string" ? JSON.parse(row.operation_detail_json) : row.operation_detail_json
  }));
}

async function handleSystemManagementApi(req, res, context) {
  const { parts, method, url, ok, readJson } = context;
  const ipAddress = req.socket.remoteAddress;

  if (method === "GET" && parts.join("/") === "api/admin/students") return ok(res, await listStudents(url));
  if (method === "GET" && parts.join("/") === "api/admin/students/template") {
    return ok(
      res,
      xlsxResponse("students-template.xlsx", [
        ["学号", "姓名", "年级", "专业", "行政班", "学生类型", "性别", "手机号", "邮箱", "状态"],
        ["2026001", "张三", "2026", "人工智能", "人工智能2601班", "normal", "男", "13800000000", "student@example.com", "active"]
      ])
    );
  }
  if (method === "GET" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "students" && parts.length === 4) {
    return ok(res, await getStudent(Number(parts[3])));
  }
  if (method === "POST" && parts.join("/") === "api/admin/students") return ok(res, await createStudent(await readJson(req), ipAddress), "学生已创建");
  if (method === "PUT" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "students" && parts.length === 4) {
    return ok(res, await updateStudent(Number(parts[3]), await readJson(req), ipAddress), "学生已更新");
  }
  if (method === "POST" && parts.join("/") === "api/admin/students/import") return ok(res, await importStudents(await readJson(req), ipAddress), "学生导入完成");

  if (method === "GET" && parts.join("/") === "api/admin/users") return ok(res, await listUsers(url));
  if (method === "GET" && parts.join("/") === "api/admin/users/template") {
    return ok(
      res,
      xlsxResponse("users-template.xlsx", [
        ["用户名", "显示名称", "密码", "角色", "状态", "手机号", "邮箱"],
        ["2026001", "张三", "123456", "student", "active", "13800000000", "student@example.com"]
      ])
    );
  }
  if (method === "POST" && parts.join("/") === "api/admin/users") return ok(res, await createUser(await readJson(req), ipAddress), "用户已创建");
  if (method === "PUT" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "users" && parts.length === 4) {
    return ok(res, await updateUser(Number(parts[3]), await readJson(req), ipAddress), "用户已更新");
  }
  if (method === "POST" && parts.join("/") === "api/admin/users/import") return ok(res, await importUsers(await readJson(req), ipAddress), "用户导入完成");
  if (method === "POST" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "users" && parts[4] === "password") {
    return ok(res, await resetPassword(Number(parts[3]), await readJson(req), ipAddress), "密码已重置");
  }
  if (method === "PUT" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "users" && parts[4] === "status") {
    return ok(res, await updateUserStatus(Number(parts[3]), await readJson(req), ipAddress), "状态已更新");
  }

  if (method === "GET" && parts.join("/") === "api/admin/operation-logs") return ok(res, await listLogs(url));

  return false;
}

export { handleSystemManagementApi, logOperation };
