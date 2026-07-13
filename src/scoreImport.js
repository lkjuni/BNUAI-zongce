import { query, transaction } from "./db.js";
import { runCalculation } from "./auditCalculation.js";
import { buildXlsx, parseXlsx, rowsToObjects } from "./xlsxLite.js";
import { logOperation } from "./systemManagement.js";
import { requireRoles } from "./auth.js";

function httpError(status, message, details) {
  const error = new Error(message);
  error.status = status;
  error.details = details;
  return error;
}

function pick(row, keys, fallback = "") {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") return String(value).trim();
  }
  return fallback;
}

function parseRows(body) {
  if (Array.isArray(body.rows)) return body.rows;
  const content = body.contentBase64 || body.content_base64;
  if (!content) throw httpError(400, "请选择需要上传的 xlsx 文件");
  return rowsToObjects(parseXlsx(Buffer.from(content, "base64")));
}

function normalizeRow(row) {
  const studentNo = pick(row, ["student_no", "studentNo", "学号"]);
  const title = pick(row, ["title", "item_name", "itemName", "项目名称", "加分项目"]);
  const scoreText = pick(row, ["score", "得分", "分数"]);
  const score = Number(scoreText);
  if (!studentNo) throw new Error("学号不能为空");
  if (!title) throw new Error("项目名称不能为空");
  if (!Number.isFinite(score)) throw new Error("分数必须是有效数字");
  return {
    studentNo,
    title,
    score: Number(score.toFixed(3)),
    description: pick(row, ["description", "remark", "说明", "备注"], "")
  };
}

function xlsxTemplate(scope) {
  const label = scope === "committee" ? "学委统一上传" : "学院统一上传";
  const buffer = buildXlsx([
    ["学号", "项目名称", "分数", "说明"],
    ["2026001", `${label}示例项目`, 1.5, "请删除示例行后填写"]
  ]);
  return {
    fileName: `${scope === "committee" ? "学委" : "学院"}统一加分导入模板.xlsx`,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    contentBase64: buffer.toString("base64")
  };
}

async function loadImportContext(academicYearId, ruleNodeId) {
  const [row] = await query(
    `SELECT y.id AS academic_year_id, y.name AS academic_year_name, y.current_snapshot_id,
            s.rule_set_version_id, n.id AS rule_node_id, n.code AS rule_code, n.name AS rule_name,
            n.node_type, n.is_apply_entry
     FROM academic_year y
     JOIN academic_year_rule_snapshot s ON s.id = y.current_snapshot_id
     JOIN rule_node n ON n.rule_set_version_id = s.rule_set_version_id AND n.id = :ruleNodeId
     WHERE y.id = :academicYearId
     LIMIT 1`,
    { academicYearId, ruleNodeId }
  );
  if (!row) throw httpError(400, "学年未绑定规则快照，或所选规则项不属于当前快照");
  if (row.node_type !== "item") throw httpError(400, "统一上传只能写入规则项，不能写入汇总节点");
  return row;
}

async function createImportedApplication(conn, context, student, row, user, batchId, scope) {
  const sourceType = scope === "committee" ? "admin_import" : "system_import";
  const [result] = await conn.execute(
    `INSERT INTO application_record
     (academic_year_id, snapshot_id, student_id, rule_node_id, rule_item_code, source_type, title, status,
      current_revision_no, audit_stage, current_auditor_role, submitted_at, approved_at, approved_by, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'approved', 1, 'final', NULL, NOW(), NOW(), ?, ?)`,
    [context.academic_year_id, context.current_snapshot_id, student.id, context.rule_node_id, context.rule_code, sourceType, row.title, user.id, user.id]
  );
  const applicationId = result.insertId;
  const fieldValues = {
    import_score: row.score,
    import_description: row.description,
    import_scope: scope,
    import_batch_id: batchId,
    import_uploader: user.displayName
  };
  for (const [key, value] of Object.entries(fieldValues)) {
    await conn.execute(
      `INSERT INTO application_field_value (application_id, field_key, field_value) VALUES (?, ?, ?)`,
      [applicationId, key, JSON.stringify(value)]
    );
  }
  await conn.execute(
    `INSERT INTO application_revision
     (application_id, revision_no, submit_type, field_values_json, attachment_snapshot_json, member_snapshot_json, submitted_by)
     VALUES (?, 1, 'import', ?, '[]', '[]', ?)`,
    [applicationId, JSON.stringify(fieldValues), user.id]
  );
  await conn.execute(
    `INSERT INTO application_audit_record
     (application_id, auditor_id, audit_role, audit_result, audit_comment)
     VALUES (?, ?, ?, 'approved', ?)`,
    [applicationId, user.id, user.role, `${scope === "committee" ? "学委" : "学院"}统一上传，系统自动认定`]
  );
  await conn.execute(
    `INSERT INTO application_operation_log (application_id, operator_id, operation_type, operation_detail_json)
     VALUES (?, ?, 'import', ?)`,
    [applicationId, user.id, JSON.stringify({ batchId, scope, score: row.score })]
  );
  return applicationId;
}

async function importScores(req, body, scope) {
  const allowedRoles = scope === "committee" ? ["class_committee"] : ["college_admin", "super_admin"];
  const user = requireRoles(req, allowedRoles);
  const academicYearId = Number(body.academicYearId || body.academic_year_id);
  const ruleNodeId = Number(body.ruleNodeId || body.rule_node_id);
  if (!academicYearId || !ruleNodeId) throw httpError(400, "请选择学年和目标规则项");
  const context = await loadImportContext(academicYearId, ruleNodeId);
  const rows = parseRows(body);
  if (!rows.length) throw httpError(400, "上传文件中没有可导入的数据行");

  let committeeClass = null;
  if (scope === "committee") {
    committeeClass = user.className;
    if (!committeeClass) throw httpError(403, "学委账号尚未关联学生及行政班，不能执行班级上传");
  }

  const result = await transaction(async (conn) => {
    const [batchResult] = await conn.execute(
      `INSERT INTO score_import_batch
       (academic_year_id, snapshot_id, rule_node_id, uploader_user_id, uploader_role, upload_scope,
        file_name, status, total_rows)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'processing', ?)`,
      [academicYearId, context.current_snapshot_id, ruleNodeId, user.id, user.role, scope, body.fileName || body.file_name || "data.xlsx", rows.length]
    );
    const batchId = batchResult.insertId;
    let success = 0;
    const errors = [];

    for (let index = 0; index < rows.length; index++) {
      let normalized = null;
      try {
        normalized = normalizeRow(rows[index]);
        const [students] = await conn.execute(
          `SELECT id, student_no, name, class_name, administrative_class
           FROM student_profile WHERE student_no = ? AND status = 'active' LIMIT 1`,
          [normalized.studentNo]
        );
        const student = students[0];
        if (!student) throw new Error("未找到状态正常的学生");
        const studentClass = student.administrative_class || student.class_name;
        if (scope === "committee" && studentClass !== committeeClass) {
          throw new Error(`只能上传本班（${committeeClass}）学生数据`);
        }
        const applicationId = await createImportedApplication(conn, context, student, normalized, user, batchId, scope);
        await conn.execute(
          `INSERT INTO score_import_row
           (batch_id, row_no, student_no, student_id, title, imported_score, description, status, application_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'succeeded', ?)`,
          [batchId, index + 2, normalized.studentNo, student.id, normalized.title, normalized.score, normalized.description || null, applicationId]
        );
        success += 1;
      } catch (error) {
        const message = error.code === "ER_DUP_ENTRY"
          ? "该学生本学年已存在此规则项申报，不能重复导入"
          : error.message || "导入失败";
        errors.push({ row: index + 2, studentNo: normalized?.studentNo || "", message });
        await conn.execute(
          `INSERT INTO score_import_row
           (batch_id, row_no, student_no, title, imported_score, description, status, error_message)
           VALUES (?, ?, ?, ?, ?, ?, 'failed', ?)`,
          [batchId, index + 2, normalized?.studentNo || null, normalized?.title || null, normalized?.score ?? null, normalized?.description || null, message]
        );
      }
    }
    await conn.execute(
      `UPDATE score_import_batch
       SET status = ?, success_rows = ?, failed_rows = ?, summary_json = ?, completed_at = NOW()
       WHERE id = ?`,
      [success ? "completed" : "failed", success, errors.length, JSON.stringify({ errors }), batchId]
    );
    await logOperation(conn, {
      operatorId: user.id,
      operatorName: user.displayName,
      module: "score_import",
      operationType: scope === "committee" ? "committee_upload" : "college_upload",
      targetType: "score_import_batch",
      targetId: batchId,
      operationDetail: { academicYearId, ruleNodeId, success, failed: errors.length },
      ipAddress: req.socket.remoteAddress
    });
    return { batchId, success, failed: errors.length, errors };
  });

  // 同一文件只在全部行落库后触发一次全量核算，避免每导入一行都产生一个结果批次。
  if (result.success) {
    result.autoCalculation = await runCalculation({
      academicYearId,
      batchType: "recalculate",
      triggerReason: `${scope}_upload:${result.batchId}`,
      createdBy: user.id
    });
  }
  return result;
}

async function listHistory(req, url) {
  const user = requireRoles(req, ["class_committee", "college_admin", "super_admin"]);
  const scope = url.searchParams.get("scope") || "";
  const academicYearId = url.searchParams.get("academicYearId") || "";
  const rows = await query(
    `SELECT b.*, y.name AS academic_year_name, n.name AS rule_name, u.display_name AS uploader_name
     FROM score_import_batch b
     JOIN academic_year y ON y.id = b.academic_year_id
     JOIN rule_node n ON n.id = b.rule_node_id
     JOIN system_user u ON u.id = b.uploader_user_id
     WHERE (:scope = '' OR b.upload_scope = :scope)
       AND (:academicYearId = '' OR b.academic_year_id = :academicYearId)
       AND (:isCommittee = 0 OR b.uploader_user_id = :userId)
     ORDER BY b.created_at DESC, b.id DESC
     LIMIT 100`,
    { scope, academicYearId, isCommittee: user.role === "class_committee" ? 1 : 0, userId: user.id }
  );
  return rows.map((row) => ({
    ...row,
    summary_json: typeof row.summary_json === "string" ? JSON.parse(row.summary_json) : row.summary_json
  }));
}

async function listImportEntries(req, url) {
  requireRoles(req, ["class_committee", "college_admin", "super_admin"]);
  const academicYearId = Number(url.searchParams.get("academicYearId") || url.searchParams.get("academic_year_id"));
  if (!academicYearId) throw httpError(400, "请选择学年");
  return query(
    `SELECT n.id, n.code, n.name, n.description, n.is_apply_entry, n.sort_order
     FROM academic_year y
     JOIN academic_year_rule_snapshot s ON s.id = y.current_snapshot_id
     JOIN rule_node n ON n.rule_set_version_id = s.rule_set_version_id
     WHERE y.id = :academicYearId AND n.node_type = 'item' AND n.status = 'enabled'
     ORDER BY n.sort_order, n.id`,
    { academicYearId }
  );
}

async function handleScoreImportApi(req, res, context) {
  const { parts, method, url, ok, readJson } = context;
  const route = parts.join("/");
  if (method === "GET" && route === "api/imports/template") {
    const scope = url.searchParams.get("scope") === "committee" ? "committee" : "college";
    requireRoles(req, scope === "committee" ? ["class_committee"] : ["college_admin", "super_admin"]);
    return ok(res, xlsxTemplate(scope));
  }
  if (method === "POST" && route === "api/imports/committee") return ok(res, await importScores(req, await readJson(req), "committee"), "学委上传完成");
  if (method === "POST" && route === "api/imports/college") return ok(res, await importScores(req, await readJson(req), "college"), "学院上传完成");
  if (method === "GET" && route === "api/imports/entries") return ok(res, await listImportEntries(req, url));
  if (method === "GET" && route === "api/imports/history") return ok(res, await listHistory(req, url));
  return false;
}

export { handleScoreImportApi };
