import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query, transaction } from "./db.js";
import { triggerAIReview } from "./aiReview.js";

// 学生申报流程：根据学年规则快照生成表单，保存草稿和证明材料，
// 并在每次正式提交时固化不可变的申报版本。

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const applicationUploadDir = path.join(rootDir, "uploads", "applications");

function parseJsonCell(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeRows(rows) {
  return rows.map((row) => {
    const normalized = { ...row };
    for (const key of Object.keys(normalized)) {
      if (key.endsWith("_json") || key === "field_value" || key === "operation_detail_json") {
        normalized[key] = parseJsonCell(normalized[key], normalized[key]);
      }
    }
    return normalized;
  });
}

function jsonValue(value) {
  if (value === undefined) return null;
  return JSON.stringify(value);
}

function toNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function makeHttpError(status, message, details = undefined) {
  const error = new Error(message);
  error.status = status;
  error.details = details;
  return error;
}

function isMissing(value) {
  return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
}

function optionValues(options) {
  if (!Array.isArray(options)) return [];
  return options.map((item) => {
    if (item && typeof item === "object") return item.value ?? item.name ?? item.label;
    return item;
  });
}

function sanitizeFileName(fileName) {
  const baseName = path.basename(String(fileName || "material.bin"));
  return baseName.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").slice(0, 160) || "material.bin";
}

function fileExtension(fileName) {
  return path.extname(fileName).replace(".", "").toLowerCase();
}

function isInsidePath(parent, target) {
  const relative = path.relative(parent, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function fetchCurrentApplyYear(academicYearId = null) {
  const rows = academicYearId
    ? await query(
        `SELECT y.*, s.rule_set_version_id
         FROM academic_year y
         JOIN academic_year_rule_snapshot s ON s.id = y.current_snapshot_id
         WHERE y.id = :academicYearId`,
        { academicYearId }
      )
    : await query(
        `SELECT y.*, s.rule_set_version_id
         FROM academic_year y
         JOIN academic_year_rule_snapshot s ON s.id = y.current_snapshot_id
         WHERE y.current_snapshot_id IS NOT NULL
         ORDER BY y.id DESC
         LIMIT 1`
      );
  const year = rows[0];
  if (!year) {
    throw makeHttpError(409, "请先创建学年并绑定规则快照");
  }
  return year;
}

function buildNodePath(node, nodeMap) {
  const names = [];
  let cursor = node;
  const seen = new Set();
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    names.unshift(cursor.name);
    cursor = cursor.parent_id ? nodeMap.get(cursor.parent_id) : null;
  }
  return names.join(" / ");
}

function groupByNode(rows) {
  return normalizeRows(rows).reduce((map, row) => {
    if (!map.has(row.node_id)) map.set(row.node_id, []);
    map.get(row.node_id).push(row);
    return map;
  }, new Map());
}

async function fetchApplyEntries(academicYearId = null) {
  // 当前学年快照确定规则版本，is_apply_entry 决定哪些具体规则项生成学生表单。
  const year = await fetchCurrentApplyYear(academicYearId);
  const nodes = await query(
    `SELECT *
     FROM rule_node
     WHERE rule_set_version_id = :versionId
     ORDER BY COALESCE(parent_id, 0), sort_order, id`,
    { versionId: year.rule_set_version_id }
  );
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const entries = nodes.filter((node) => node.is_apply_entry && node.status === "enabled");
  if (!entries.length) {
    return { year, entries: [] };
  }

  const ids = entries.map((node) => node.id);
  const placeholders = ids.map((_, index) => `:id${index}`).join(",");
  const params = Object.fromEntries(ids.map((id, index) => [`id${index}`, id]));
  const [calculationConfigs, formFields, materialRequirements, auditRequirements, scopes, groupRules] =
    await Promise.all([
      query(`SELECT * FROM rule_calculation_config WHERE node_id IN (${placeholders}) ORDER BY sort_order, id`, params),
      query(`SELECT * FROM rule_form_field WHERE node_id IN (${placeholders}) ORDER BY sort_order, id`, params),
      query(`SELECT * FROM material_requirement WHERE node_id IN (${placeholders}) ORDER BY id`, params),
      query(`SELECT * FROM audit_requirement WHERE node_id IN (${placeholders}) ORDER BY id`, params),
      query(`SELECT * FROM rule_scope WHERE node_id IN (${placeholders}) ORDER BY id`, params),
      query(`SELECT * FROM group_distribution_rule WHERE node_id IN (${placeholders}) ORDER BY id`, params)
    ]);

  const calcByNode = groupByNode(calculationConfigs);
  const fieldByNode = groupByNode(formFields);
  const materialByNode = groupByNode(materialRequirements);
  const auditByNode = groupByNode(auditRequirements);
  const scopeByNode = groupByNode(scopes);
  const groupByNodeId = groupByNode(groupRules);

  return {
    year,
    entries: entries.map((node) => ({
      ...node,
      academic_year_id: year.id,
      academic_year_name: year.name,
      snapshot_id: year.current_snapshot_id,
      path_name: buildNodePath(node, nodeMap),
      calculation_configs: calcByNode.get(node.id) || [],
      form_fields: fieldByNode.get(node.id) || [],
      material_requirements: materialByNode.get(node.id) || [],
      audit_requirements: auditByNode.get(node.id) || [],
      scopes: scopeByNode.get(node.id) || [],
      group_distribution_rules: groupByNodeId.get(node.id) || []
    }))
  };
}

async function fetchApplicationDetail(applicationId) {
  const [application] = await query(
    `SELECT a.*, n.name AS rule_name, n.code AS rule_code, n.node_type, y.name AS academic_year_name
     FROM application_record a
     JOIN rule_node n ON n.id = a.rule_node_id
     JOIN academic_year y ON y.id = a.academic_year_id
     WHERE a.id = :applicationId`,
    { applicationId }
  );
  if (!application) {
    throw makeHttpError(404, "申报记录不存在");
  }

  const [fields, attachments, members, materials, formFields, revisions, operations] = await Promise.all([
    query(`SELECT * FROM application_field_value WHERE application_id = :applicationId ORDER BY id`, { applicationId }),
    query(`SELECT * FROM application_attachment WHERE application_id = :applicationId ORDER BY id`, { applicationId }),
    query(`SELECT * FROM application_member WHERE application_id = :applicationId ORDER BY rank_no, id`, { applicationId }),
    query(`SELECT * FROM material_requirement WHERE node_id = :nodeId ORDER BY id`, { nodeId: application.rule_node_id }),
    query(`SELECT * FROM rule_form_field WHERE node_id = :nodeId ORDER BY sort_order, id`, { nodeId: application.rule_node_id }),
    query(`SELECT * FROM application_revision WHERE application_id = :applicationId ORDER BY revision_no`, { applicationId }),
    query(`SELECT * FROM application_operation_log WHERE application_id = :applicationId ORDER BY created_at`, { applicationId })
  ]);

  return {
    ...application,
    fields: normalizeRows(fields),
    attachments: normalizeRows(attachments),
    members,
    material_requirements: normalizeRows(materials),
    form_fields: normalizeRows(formFields),
    revisions: normalizeRows(revisions),
    operations: normalizeRows(operations)
  };
}

async function loadNodeConfigForUpdate(conn, academicYearId, ruleNodeId) {
  // 草稿只能关联当前学年快照中的规则项，防止客户端提交任意节点或跨学年节点。
  const [rows] = await conn.execute(
    `SELECT y.id AS academic_year_id, y.name AS academic_year_name, y.current_snapshot_id,
            y.apply_start_time AS year_apply_start_time, y.apply_end_time AS year_apply_end_time,
            s.rule_set_version_id,
            n.id AS node_id, n.code, n.name, n.allow_repeat, n.duplicate_check_type,
            n.duplicate_check_config_json, n.apply_start_time AS node_apply_start_time,
            n.apply_end_time AS node_apply_end_time, n.submitter_type
     FROM academic_year y
     JOIN academic_year_rule_snapshot s ON s.id = y.current_snapshot_id
     JOIN rule_node n ON n.rule_set_version_id = s.rule_set_version_id
     WHERE y.id = ? AND n.id = ? AND n.is_apply_entry = 1 AND n.status = 'enabled'`,
    [academicYearId, ruleNodeId]
  );
  const row = rows[0];
  if (!row) {
    throw makeHttpError(400, "该学年当前规则快照中不存在这个可申报规则项");
  }

  const [formFields] = await conn.execute(
    `SELECT * FROM rule_form_field WHERE node_id = ? ORDER BY sort_order, id`,
    [ruleNodeId]
  );
  const [materials] = await conn.execute(
    `SELECT * FROM material_requirement WHERE node_id = ? ORDER BY id`,
    [ruleNodeId]
  );

  return {
    year: {
      id: row.academic_year_id,
      name: row.academic_year_name,
      current_snapshot_id: row.current_snapshot_id,
      rule_set_version_id: row.rule_set_version_id,
      apply_start_time: row.year_apply_start_time,
      apply_end_time: row.year_apply_end_time
    },
    node: {
      id: row.node_id,
      code: row.code,
      name: row.name,
      allow_repeat: row.allow_repeat,
      duplicate_check_type: row.duplicate_check_type,
      duplicate_check_config_json: parseJsonCell(row.duplicate_check_config_json, null),
      apply_start_time: row.node_apply_start_time,
      apply_end_time: row.node_apply_end_time,
      submitter_type: row.submitter_type
    },
    formFields: normalizeRows(formFields),
    materials: normalizeRows(materials)
  };
}

function validateApplyWindow(year, node, strict = false) {
  if (!strict) return;
  const now = Date.now();
  const start = node.apply_start_time || year.apply_start_time;
  const end = node.apply_end_time || year.apply_end_time;
  if (start && now < new Date(start).getTime()) {
    throw makeHttpError(400, "当前未到申报开始时间");
  }
  if (end && now > new Date(end).getTime()) {
    throw makeHttpError(400, "当前已超过申报截止时间");
  }
}

function validateFieldValues(formFields, fieldValues) {
  const errors = [];
  const values = fieldValues && typeof fieldValues === "object" ? fieldValues : {};
  for (const field of formFields) {
    const value = values[field.field_key];
    if (field.required && isMissing(value)) {
      errors.push(`${field.field_label} 为必填项`);
      continue;
    }
    if (isMissing(value)) continue;

    const options = optionValues(parseJsonCell(field.options_json, []));
    if (options.length && ["select", "multi_select"].includes(field.field_type)) {
      const submitted = Array.isArray(value) ? value : [value];
      const invalid = submitted.filter((item) => !options.map(String).includes(String(item)));
      if (invalid.length) {
        errors.push(`${field.field_label} 包含无效选项：${invalid.join(", ")}`);
      }
    }

    if (field.field_type === "number") {
      const number = toNumber(value);
      const validation = parseJsonCell(field.validation_json, {});
      if (number === null) errors.push(`${field.field_label} 必须是数字`);
      if (number !== null && validation?.min !== undefined && number < Number(validation.min)) {
        errors.push(`${field.field_label} 不能小于 ${validation.min}`);
      }
      if (number !== null && validation?.max !== undefined && number > Number(validation.max)) {
        errors.push(`${field.field_label} 不能大于 ${validation.max}`);
      }
    }
  }
  if (errors.length) {
    throw makeHttpError(400, "申报字段校验未通过", errors);
  }
}

async function validateDuplicate(conn, { academicYearId, studentId, ruleCode, excludeApplicationId = null }) {
  // 规则项在业务上固定为每人每学年一条。这里先给出友好错误，数据库唯一键负责并发兜底。
  const [rows] = await conn.execute(
    `SELECT COUNT(*) AS count
     FROM application_record a
     WHERE a.academic_year_id = ?
       AND a.student_id = ?
       AND a.rule_item_code = ?
       AND (? IS NULL OR a.id <> ?)`,
    [academicYearId, studentId, ruleCode, excludeApplicationId, excludeApplicationId]
  );
  if (Number(rows[0].count) > 0) {
    throw makeHttpError(409, "该规则项不允许重复申报，当前学生已存在相关申报记录");
  }
}

async function writeFieldValues(conn, applicationId, fieldValues) {
  await conn.execute(`DELETE FROM application_field_value WHERE application_id = ?`, [applicationId]);
  for (const [fieldKey, value] of Object.entries(fieldValues || {})) {
    await conn.execute(
      `INSERT INTO application_field_value (application_id, field_key, field_value)
       VALUES (?, ?, ?)`,
      [applicationId, fieldKey, jsonValue(value)]
    );
  }
}

async function writeMembers(conn, applicationId, members = []) {
  await conn.execute(`DELETE FROM application_member WHERE application_id = ?`, [applicationId]);
  if (!Array.isArray(members)) return;
  for (const member of members) {
    await conn.execute(
      `INSERT INTO application_member
       (application_id, member_student_id, member_name, role_name, rank_no, contribution_ratio)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        applicationId,
        member.member_student_id || member.memberStudentId || null,
        member.member_name || member.memberName || null,
        member.role_name || member.roleName || null,
        member.rank_no || member.rankNo || null,
        member.contribution_ratio ?? member.contributionRatio ?? null
      ]
    );
  }
}

async function logApplicationOperation(conn, applicationId, operatorId, operationType, detail = {}) {
  await conn.execute(
    `INSERT INTO application_operation_log (application_id, operator_id, operation_type, operation_detail_json)
     VALUES (?, ?, ?, ?)`,
    [applicationId, operatorId, operationType, JSON.stringify(detail)]
  );
}

async function insertApplicationRevision(conn, applicationId, revisionNo, submittedBy, submitType) {
  // 提交版本是不可变 JSON 快照，用于还原退回重提之前每一次正式提交的内容。
  const [fields] = await conn.execute(
    `SELECT field_key, field_value FROM application_field_value WHERE application_id = ? ORDER BY id`,
    [applicationId]
  );
  const [attachments] = await conn.execute(
    `SELECT id, material_requirement_id, file_name, file_url, file_hash, status, revision_no
     FROM application_attachment WHERE application_id = ? AND status = 'active' ORDER BY id`,
    [applicationId]
  );
  const [members] = await conn.execute(
    `SELECT member_student_id, member_name, role_name, rank_no, contribution_ratio
     FROM application_member WHERE application_id = ? ORDER BY rank_no, id`,
    [applicationId]
  );
  await conn.execute(
    `INSERT INTO application_revision
     (application_id, revision_no, submit_type, field_values_json, attachment_snapshot_json, member_snapshot_json, submitted_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      applicationId,
      revisionNo,
      submitType,
      JSON.stringify(normalizeRows(fields)),
      JSON.stringify(attachments),
      JSON.stringify(members),
      submittedBy
    ]
  );
}

async function validateRequiredMaterials(conn, applicationId, materials) {
  const required = materials.filter((row) => row.required);
  if (!required.length) return;

  const [rows] = await conn.execute(
    `SELECT material_requirement_id, COUNT(*) AS count
     FROM application_attachment
     WHERE application_id = ? AND status = 'active'
     GROUP BY material_requirement_id`,
    [applicationId]
  );
  const countByMaterial = new Map(rows.map((row) => [row.material_requirement_id, Number(row.count)]));
  const missing = required.filter((row) => !countByMaterial.get(row.id));
  if (missing.length) {
    throw makeHttpError(400, "请先上传必需证明材料", missing.map((row) => row.material_name));
  }
}

async function loadApplicationForUpdate(conn, applicationId) {
  const [rows] = await conn.execute(
    `SELECT a.*, n.code AS rule_code, n.name AS rule_name, n.allow_repeat
     FROM application_record a
     JOIN rule_node n ON n.id = a.rule_node_id
     WHERE a.id = ?
     FOR UPDATE`,
    [applicationId]
  );
  const application = rows[0];
  if (!application) {
    throw makeHttpError(404, "申报记录不存在");
  }
  return application;
}

async function submitApplicationTx(conn, applicationId, studentId, operatorId) {
  // 提交操作在同一事务中校验必需材料、推进状态并写入不可变申报版本。
  const application = await loadApplicationForUpdate(conn, applicationId);
  if (studentId && Number(application.student_id) !== Number(studentId)) {
    throw makeHttpError(403, "不能提交其他学生的申报记录");
  }
  if (!["draft", "returned"].includes(application.status)) {
    throw makeHttpError(400, "只有草稿或被退回的申报可以提交");
  }

  const config = await loadNodeConfigForUpdate(conn, application.academic_year_id, application.rule_node_id);
  const [fieldRows] = await conn.execute(
    `SELECT field_key, field_value FROM application_field_value WHERE application_id = ?`,
    [applicationId]
  );
  const fieldValues = Object.fromEntries(normalizeRows(fieldRows).map((row) => [row.field_key, row.field_value]));
  validateFieldValues(config.formFields, fieldValues);
  await validateRequiredMaterials(conn, applicationId, config.materials);

  const revisionNo = Number(application.current_revision_no || 0) + 1;
  const submitType = revisionNo === 1 ? "initial" : "resubmit";
  await conn.execute(
    `UPDATE application_attachment
     SET revision_no = ?
     WHERE application_id = ? AND status = 'active'`,
    [revisionNo, applicationId]
  );
  await conn.execute(
    `UPDATE application_record
     SET status = 'submitted',
         current_revision_no = ?,
         audit_stage = 'class_review',
         current_auditor_role = 'class_committee',
         submitted_at = NOW(),
         rejected_at = NULL,
         rejected_by = NULL,
         reject_reason = NULL
     WHERE id = ?`,
    [revisionNo, applicationId]
  );
  await insertApplicationRevision(conn, applicationId, revisionNo, operatorId, submitType);
  await logApplicationOperation(conn, applicationId, operatorId, submitType === "initial" ? "submit" : "resubmit", {
    revision_no: revisionNo
  });
  return { id: applicationId, status: "submitted", revisionNo };
}

async function createApplication(body) {
  const academicYearId = Number(body.academic_year_id || body.academicYearId);
  const ruleNodeId = Number(body.rule_node_id || body.ruleNodeId);
  const studentId = Number(body.student_id || body.studentId);
  if (!academicYearId || !ruleNodeId || !studentId) {
    throw makeHttpError(400, "academicYearId、ruleNodeId、studentId 均不能为空");
  }

  const title = body.title || "未命名申报";
  const fieldValues = body.field_values || body.fieldValues || {};
  const members = body.members || [];
  let created;
  try {
    created = await transaction(async (conn) => {
      const config = await loadNodeConfigForUpdate(conn, academicYearId, ruleNodeId);
      validateApplyWindow(config.year, config.node, Boolean(body.enforceApplyWindow));
      validateFieldValues(config.formFields, fieldValues);
      await validateDuplicate(conn, { academicYearId, studentId, ruleCode: config.node.code });

      const [result] = await conn.execute(
        `INSERT INTO application_record
         (academic_year_id, snapshot_id, student_id, rule_node_id, rule_item_code, source_type, title, status, created_by)
         VALUES (?, ?, ?, ?, ?, 'student_apply', ?, 'draft', ?)`,
        [academicYearId, config.year.current_snapshot_id, studentId, ruleNodeId, config.node.code, title, studentId]
      );
      const applicationId = result.insertId;
      await writeFieldValues(conn, applicationId, fieldValues);
      await writeMembers(conn, applicationId, members);
      await logApplicationOperation(conn, applicationId, studentId, "create", { title });
      return { id: applicationId };
    });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") {
      throw makeHttpError(409, "每名学生每学年只能为同一规则项创建一条申报，请修改已有记录");
    }
    throw error;
  }

  return fetchApplicationDetail(created.id);
}

async function updateApplication(applicationId, body) {
  const studentId = Number(body.student_id || body.studentId);
  const fieldValues = body.field_values || body.fieldValues || {};
  const members = body.members || [];
  await transaction(async (conn) => {
    const application = await loadApplicationForUpdate(conn, applicationId);
    if (studentId && Number(application.student_id) !== Number(studentId)) {
      throw makeHttpError(403, "不能修改其他学生的申报记录");
    }
    if (!["draft", "returned"].includes(application.status)) {
      throw makeHttpError(400, "只有草稿或被退回的申报可以修改");
    }
    const config = await loadNodeConfigForUpdate(conn, application.academic_year_id, application.rule_node_id);
    validateApplyWindow(config.year, config.node, Boolean(body.enforceApplyWindow));
    validateFieldValues(config.formFields, fieldValues);
    await validateDuplicate(conn, {
      academicYearId: application.academic_year_id,
      studentId: application.student_id,
      ruleCode: config.node.code,
      excludeApplicationId: application.id
    });
    await conn.execute(
      `UPDATE application_record
       SET title = ?
       WHERE id = ?`,
      [body.title || application.title, applicationId]
    );
    await writeFieldValues(conn, applicationId, fieldValues);
    await writeMembers(conn, applicationId, members);
    await logApplicationOperation(conn, applicationId, studentId || application.student_id, "save", {
      status: application.status
    });
  });
  return fetchApplicationDetail(applicationId);
}

async function submitApplication(applicationId, body) {
  const studentId = Number(body.student_id || body.studentId);
  const operatorId = studentId || Number(body.operator_id || body.operatorId || 1);
  const result = await transaction(async (conn) => submitApplicationTx(conn, applicationId, studentId, operatorId));
  return { ...result, detail: await fetchApplicationDetail(applicationId) };
}

async function attachMaterial(applicationId, body) {
  // 先写入文件再保存元数据；storage_key 使用相对路径，便于后续迁移到对象存储。
  const studentId = Number(body.student_id || body.studentId);
  const materialRequirementId = body.material_requirement_id || body.materialRequirementId
    ? Number(body.material_requirement_id || body.materialRequirementId)
    : null;
  const fileName = sanitizeFileName(body.file_name || body.fileName);
  const contentBase64 = String(body.content_base64 || body.contentBase64 || "");
  if (!contentBase64) {
    throw makeHttpError(400, "材料内容不能为空");
  }
  const fileBuffer = Buffer.from(contentBase64, "base64");
  if (!fileBuffer.length) {
    throw makeHttpError(400, "材料内容解析失败");
  }

  const result = await transaction(async (conn) => {
    const application = await loadApplicationForUpdate(conn, applicationId);
    if (studentId && Number(application.student_id) !== Number(studentId)) {
      throw makeHttpError(403, "不能为其他学生的申报上传材料");
    }
    if (!["draft", "returned"].includes(application.status)) {
      throw makeHttpError(400, "只有草稿或被退回的申报可以继续上传材料");
    }

    let material = null;
    if (materialRequirementId) {
      const [materials] = await conn.execute(
        `SELECT * FROM material_requirement WHERE id = ? AND node_id = ?`,
        [materialRequirementId, application.rule_node_id]
      );
      material = materials[0];
      if (!material) {
        throw makeHttpError(400, "材料要求不属于该申报规则项");
      }
      const allowed = String(material.file_type_limit || "")
        .split(",")
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean);
      const ext = fileExtension(fileName);
      if (allowed.length && ext && !allowed.includes(ext)) {
        throw makeHttpError(400, `文件类型不符合要求，仅允许：${allowed.join(", ")}`);
      }
      const [counts] = await conn.execute(
        `SELECT COUNT(*) AS count
         FROM application_attachment
         WHERE application_id = ? AND material_requirement_id = ? AND status = 'active'`,
        [applicationId, materialRequirementId]
      );
      if (Number(counts[0].count) >= Number(material.max_file_count || 1)) {
        throw makeHttpError(400, "该材料类型已达到最大上传数量");
      }
    }

    const storedName = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}-${fileName}`;
    const relativePath = path.join(String(applicationId), storedName);
    const absoluteDir = path.join(applicationUploadDir, String(applicationId));
    const absolutePath = path.join(applicationUploadDir, relativePath);
    if (!isInsidePath(applicationUploadDir, absolutePath)) {
      throw makeHttpError(400, "文件路径不合法");
    }
    await fs.mkdir(absoluteDir, { recursive: true });
    await fs.writeFile(absolutePath, fileBuffer);

    const hash = crypto.createHash("sha256").update(fileBuffer).digest("hex");
    const fileUrl = `/uploads/applications/${applicationId}/${storedName}`;
    const [insert] = await conn.execute(
      `INSERT INTO application_attachment
       (application_id, material_requirement_id, file_name, file_url, file_hash, revision_no, status,
        file_size, mime_type, storage_key, review_result, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, 'pending', ?)`,
      [
        applicationId,
        materialRequirementId,
        fileName,
        fileUrl,
        hash,
        application.current_revision_no || 0,
        body.file_size || body.fileSize || fileBuffer.length,
        body.mime_type || body.mimeType || "application/octet-stream",
        `applications/${relativePath.replace(/\\/g, "/")}`,
        studentId || application.student_id
      ]
    );
    await logApplicationOperation(conn, applicationId, studentId || application.student_id, "upload_material", {
      attachment_id: insert.insertId,
      material_requirement_id: materialRequirementId,
      file_name: fileName
    });
    return { id: insert.insertId, fileUrl };
  });

  // 异步触发 AI 审核，不阻塞上传响应
  triggerAIReview(result.id, applicationId, result.fileUrl, fileName);

  return { ...result, detail: await fetchApplicationDetail(applicationId) };
}

async function deleteAttachment(attachmentId, body) {
  const studentId = Number(body.student_id || body.studentId);
  const result = await transaction(async (conn) => {
    const [rows] = await conn.execute(
      `SELECT att.*, a.student_id, a.status AS application_status
       FROM application_attachment att
       JOIN application_record a ON a.id = att.application_id
       WHERE att.id = ?
       FOR UPDATE`,
      [attachmentId]
    );
    const attachment = rows[0];
    if (!attachment) {
      throw makeHttpError(404, "材料不存在");
    }
    if (studentId && Number(attachment.student_id) !== Number(studentId)) {
      throw makeHttpError(403, "不能删除其他学生的材料");
    }
    if (!["draft", "returned"].includes(attachment.application_status)) {
      throw makeHttpError(400, "只有草稿或被退回的申报可以删除材料");
    }
    await conn.execute(`UPDATE application_attachment SET status = 'deleted' WHERE id = ?`, [attachmentId]);
    await logApplicationOperation(conn, attachment.application_id, studentId || attachment.student_id, "delete_material", {
      attachment_id: attachmentId
    });
    return { applicationId: attachment.application_id, attachmentId };
  });
  return result;
}

async function withdrawApplication(applicationId, body) {
  const studentId = Number(body.student_id || body.studentId);
  await transaction(async (conn) => {
    const application = await loadApplicationForUpdate(conn, applicationId);
    if (studentId && Number(application.student_id) !== Number(studentId)) {
      throw makeHttpError(403, "不能撤回其他学生的申报记录");
    }
    if (!["draft", "submitted", "returned"].includes(application.status)) {
      throw makeHttpError(400, "当前状态不允许撤回");
    }
    await conn.execute(
      `UPDATE application_record
       SET status = 'withdrawn', audit_stage = NULL, current_auditor_role = NULL
       WHERE id = ?`,
      [applicationId]
    );
    await logApplicationOperation(conn, applicationId, studentId || application.student_id, "withdraw", {
      previous_status: application.status
    });
  });
  return fetchApplicationDetail(applicationId);
}

async function listStudentApplications(url) {
  const academicYearId = url.searchParams.get("academicYearId") || url.searchParams.get("academic_year_id");
  const studentId = url.searchParams.get("studentId") || url.searchParams.get("student_id");
  const rows = await query(
    `SELECT a.id, a.academic_year_id, y.name AS academic_year_name, a.snapshot_id, a.student_id,
            a.rule_node_id, n.name AS rule_name, n.code AS rule_code, a.title, a.status,
            a.current_revision_no, a.audit_stage, a.current_auditor_role,
            a.submitted_at, a.approved_at, a.returned_at, a.created_at, a.updated_at,
            COUNT(att.id) AS attachment_count
     FROM application_record a
     JOIN academic_year y ON y.id = a.academic_year_id
     JOIN rule_node n ON n.id = a.rule_node_id
     LEFT JOIN application_attachment att ON att.application_id = a.id AND att.status = 'active'
     WHERE (:academicYearId IS NULL OR a.academic_year_id = :academicYearId)
       AND (:studentId IS NULL OR a.student_id = :studentId)
     GROUP BY a.id
     ORDER BY a.updated_at DESC, a.id DESC`,
    {
      academicYearId: academicYearId ? Number(academicYearId) : null,
      studentId: studentId ? Number(studentId) : null
    }
  );
  return rows;
}

async function handleApplicationSubmissionApi(req, res, context) {
  const { parts, method, url, ok, readJson } = context;

  if (method === "GET" && parts.join("/") === "api/apply/years") {
    const rows = await query(
      `SELECT y.*, s.rule_set_version_id
       FROM academic_year y
       LEFT JOIN academic_year_rule_snapshot s ON s.id = y.current_snapshot_id
       WHERE y.current_snapshot_id IS NOT NULL
       ORDER BY y.id DESC`
    );
    return ok(res, rows);
  }

  if (method === "GET" && parts.join("/") === "api/apply/entries") {
    const academicYearId = url.searchParams.get("academicYearId") || url.searchParams.get("academic_year_id");
    const data = await fetchApplyEntries(academicYearId ? Number(academicYearId) : null);
    return ok(res, data);
  }

  if (method === "GET" && parts.join("/") === "api/apply/applications") {
    const rows = await listStudentApplications(url);
    return ok(res, rows);
  }

  if (method === "POST" && parts.join("/") === "api/apply/applications") {
    const body = await readJson(req);
    const detail = await createApplication(body);
    return ok(res, detail, "申报草稿已保存");
  }

  if (method === "GET" && parts[0] === "api" && parts[1] === "apply" && parts[2] === "applications" && parts[4] === "revisions") {
    const applicationId = Number(parts[3]);
    const rows = await query(
      `SELECT * FROM application_revision WHERE application_id = :applicationId ORDER BY revision_no`,
      { applicationId }
    );
    return ok(res, normalizeRows(rows));
  }

  if (method === "GET" && parts[0] === "api" && parts[1] === "apply" && parts[2] === "applications" && parts.length === 4) {
    const detail = await fetchApplicationDetail(Number(parts[3]));
    return ok(res, detail);
  }

  if (method === "PUT" && parts[0] === "api" && parts[1] === "apply" && parts[2] === "applications" && parts.length === 4) {
    const body = await readJson(req);
    const detail = await updateApplication(Number(parts[3]), body);
    return ok(res, detail, "申报草稿已更新");
  }

  if (method === "POST" && parts[0] === "api" && parts[1] === "apply" && parts[2] === "applications" && parts[4] === "submit") {
    const body = await readJson(req);
    const data = await submitApplication(Number(parts[3]), body);
    return ok(res, data, "申报已提交，等待审核");
  }

  if (method === "POST" && parts[0] === "api" && parts[1] === "apply" && parts[2] === "applications" && parts[4] === "attachments") {
    const body = await readJson(req);
    const data = await attachMaterial(Number(parts[3]), body);
    return ok(res, data, "证明材料已上传");
  }

  if (method === "POST" && parts[0] === "api" && parts[1] === "apply" && parts[2] === "applications" && parts[4] === "withdraw") {
    const body = await readJson(req);
    const detail = await withdrawApplication(Number(parts[3]), body);
    return ok(res, detail, "申报已撤回");
  }

  if (method === "DELETE" && parts[0] === "api" && parts[1] === "apply" && parts[2] === "attachments" && parts.length === 4) {
    const body = await readJson(req);
    const data = await deleteAttachment(Number(parts[3]), body);
    return ok(res, data, "证明材料已删除");
  }

  return false;
}

export { handleApplicationSubmissionApi };
