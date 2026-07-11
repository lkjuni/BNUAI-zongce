import { query, transaction, jsonParam } from "./db.js";

function parseJsonCell(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeRows(rows) {
  return rows.map((row) => {
    for (const key of Object.keys(row)) {
      if (key.endsWith("_json") || key === "field_value" || key === "config_json") {
        row[key] = parseJsonCell(row[key], row[key]);
      }
    }
    return row;
  });
}

async function fetchCurrentYear() {
  const [year] = await query(
    `SELECT y.*, s.rule_set_version_id
     FROM academic_year y
     JOIN academic_year_rule_snapshot s ON s.id = y.current_snapshot_id
     WHERE y.current_snapshot_id IS NOT NULL
     ORDER BY y.id DESC
     LIMIT 1`
  );
  if (!year) {
    const error = new Error("请先创建学年并绑定规则快照");
    error.status = 409;
    throw error;
  }
  return year;
}

async function fetchApplicationDetail(applicationId) {
  const [application] = await query(
    `SELECT a.*, n.name AS rule_name, n.code AS rule_code, n.node_type, n.aggregation_type
     FROM application_record a
     JOIN rule_node n ON n.id = a.rule_node_id
     WHERE a.id = :applicationId`,
    { applicationId }
  );
  if (!application) {
    const error = new Error("申报记录不存在");
    error.status = 404;
    throw error;
  }

  const [fields, attachments, members, audits, requirements, materials, revisions, operations] = await Promise.all([
    query(`SELECT * FROM application_field_value WHERE application_id = :applicationId ORDER BY id`, { applicationId }),
    query(`SELECT * FROM application_attachment WHERE application_id = :applicationId ORDER BY id`, { applicationId }),
    query(`SELECT * FROM application_member WHERE application_id = :applicationId ORDER BY rank_no, id`, { applicationId }),
    query(`SELECT * FROM application_audit_record WHERE application_id = :applicationId ORDER BY audited_at`, { applicationId }),
    query(`SELECT * FROM audit_requirement WHERE node_id = :nodeId ORDER BY id`, { nodeId: application.rule_node_id }),
    query(`SELECT * FROM material_requirement WHERE node_id = :nodeId ORDER BY id`, { nodeId: application.rule_node_id }),
    query(`SELECT * FROM application_revision WHERE application_id = :applicationId ORDER BY revision_no`, { applicationId }),
    query(`SELECT * FROM application_operation_log WHERE application_id = :applicationId ORDER BY created_at`, { applicationId })
  ]);

  return {
    ...application,
    fields: normalizeRows(fields),
    attachments: normalizeRows(attachments),
    members,
    audits: normalizeRows(audits),
    audit_requirements: normalizeRows(requirements),
    material_requirements: materials,
    revisions: normalizeRows(revisions),
    operations: normalizeRows(operations)
  };
}

async function insertApplicationRevision(conn, applicationId, revisionNo, submittedBy, submitType = "initial") {
  const [fields] = await conn.execute(
    `SELECT field_key, field_value FROM application_field_value WHERE application_id = ? ORDER BY id`,
    [applicationId]
  );
  const [attachments] = await conn.execute(
    `SELECT id, material_requirement_id, file_name, file_url, file_hash, status
     FROM application_attachment WHERE application_id = ? ORDER BY id`,
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

async function logApplicationOperation(conn, applicationId, operatorId, operationType, detail = {}) {
  await conn.execute(
    `INSERT INTO application_operation_log (application_id, operator_id, operation_type, operation_detail_json)
     VALUES (?, ?, ?, ?)`,
    [applicationId, operatorId, operationType, JSON.stringify(detail)]
  );
}

async function createDemoApplication(conn, { year, node, studentId, title, fields, members = [] }) {
  const [appResult] = await conn.execute(
    `INSERT INTO application_record
     (academic_year_id, snapshot_id, student_id, rule_node_id, source_type, title, status,
      current_revision_no, audit_stage, current_auditor_role, submitted_at, created_by)
     VALUES (?, ?, ?, ?, 'student_apply', ?, 'submitted', 1, 'class_review', 'class_committee', NOW(), ?)`,
    [year.id, year.current_snapshot_id, studentId, node.id, title, studentId]
  );
  const applicationId = appResult.insertId;

  for (const [key, value] of Object.entries(fields)) {
    await conn.execute(
      `INSERT INTO application_field_value (application_id, field_key, field_value)
       VALUES (?, ?, ?)`,
      [applicationId, key, JSON.stringify(value)]
    );
  }

  const [materialRows] = await conn.execute(
    `SELECT id, material_name FROM material_requirement WHERE node_id = ? ORDER BY id LIMIT 1`,
    [node.id]
  );
  const materialId = materialRows[0]?.id || null;
  await conn.execute(
    `INSERT INTO application_attachment
     (application_id, material_requirement_id, file_name, file_url, file_hash, revision_no, status,
      file_size, mime_type, storage_key, review_result, uploaded_by)
     VALUES (?, ?, ?, ?, SHA2(?, 256), 1, 'active', 1024, 'application/pdf', ?, 'pending', ?)`,
    [
      applicationId,
      materialId,
      `${title}.pdf`,
      `demo://${applicationId}/proof.pdf`,
      `${applicationId}:${title}`,
      `demo/applications/${applicationId}/proof.pdf`,
      studentId
    ]
  );

  for (const member of members) {
    await conn.execute(
      `INSERT INTO application_member
       (application_id, member_student_id, member_name, role_name, rank_no, contribution_ratio)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        applicationId,
        member.member_student_id || null,
        member.member_name || null,
        member.role_name || null,
        member.rank_no || null,
        member.contribution_ratio || null
      ]
    );
  }

  await insertApplicationRevision(conn, applicationId, 1, studentId, "initial");
  await logApplicationOperation(conn, applicationId, studentId, "submit", { source: "demo" });
  return applicationId;
}

function firstLevelName(config) {
  return config?.levels?.[0]?.name || "level-1";
}

function firstWeightName(config) {
  return config?.weights?.[0]?.name || "weight-1";
}

function firstBaseScoreName(config) {
  return config?.base_scores?.[0]?.name || "position-1";
}

async function seedAuditCalculationDemo() {
  const year = await fetchCurrentYear();
  const versionId = year.rule_set_version_id;
  const nodes = await query(
    `SELECT n.*, c.config_json, c.config_type, c.formula_code
     FROM rule_node n
     LEFT JOIN rule_calculation_config c ON c.node_id = n.id
     WHERE n.rule_set_version_id = :versionId
       AND n.is_apply_entry = 1
     ORDER BY n.id`,
    { versionId }
  );
  const byCode = new Map(nodes.map((node) => [node.code, node]));
  const preferred = [
    "student_work.activity.sports.award",
    "student_work.activity.sports.rank",
    "innovation.research.paper.publication",
    "innovation.research.paper.level",
    "student_work.position.role",
    "student_work.position.class",
    "innovation.competition.creative.award",
    "innovation.competition.creative.challenge_cup"
  ];
  let selected = preferred.map((code) => byCode.get(code)).filter(Boolean);
  if (!selected.length) {
    selected = nodes.filter((node) => node.config_json).slice(0, 4);
  }
  if (!selected.length) {
    const error = new Error("当前规则快照中没有可申报规则项");
    error.status = 409;
    throw error;
  }

  return transaction(async (conn) => {
    await conn.execute(
      `INSERT IGNORE INTO formula_template
       (formula_code, formula_name, description, input_schema_json, output_schema_json)
       VALUES
       ('BASE_SCORE_TIMES_WEIGHT', 'base score times weight', 'Score equals base score multiplied by configured weight.', '{"base_score":"number","weight":"number"}', '{"score":"number"}'),
       ('POSITION_SCORE_BY_WEIGHT', 'position score by evaluation weight', 'Position score equals base position score multiplied by evaluation weight.', '{"base_score":"number","evaluation_weight":"number"}', '{"score":"number"}'),
       ('LEVEL_SCORE', 'level score', 'Score is selected from a configured level list.', '{"level":"string"}', '{"score":"number"}'),
       ('FIXED_SCORE', 'fixed score', 'Score is configured as a fixed value.', '{"score":"number"}', '{"score":"number"}')`
    );

    const created = [];
    let studentId = 2026001;
    for (const node of selected) {
      const config = parseJsonCell(node.config_json, {});
      let fields = {};
      if (node.code.includes("sports")) {
        fields = { award_level: firstLevelName(config), event_weight: firstWeightName(config), event_name: "sports-demo" };
      } else if (node.code.includes("paper")) {
        fields = { paper_level: firstLevelName(config), paper_title: "paper-demo" };
      } else if (node.code.includes("position")) {
        fields = { position_name: firstBaseScoreName(config), evaluation_weight: 0.9 };
      } else if (node.code.includes("competition")) {
        fields = { competition_level: firstLevelName(config), member_role: "leader" };
      } else if (node.formula_code === "POSITION_SCORE_BY_WEIGHT") {
        fields = { position_name: firstBaseScoreName(config), evaluation_weight: 0.9 };
      } else if (node.config_type === "weight") {
        fields = { demo_level: firstLevelName(config), demo_weight: firstWeightName(config) };
      } else if (node.config_type === "level") {
        fields = { demo_level: firstLevelName(config) };
      } else {
        fields = { demo_value: "demo" };
      }
      created.push(
        await createDemoApplication(conn, {
          year,
          node,
          studentId,
          title: `${node.code}-${studentId}`,
          fields,
          members: [{ member_student_id: studentId, member_name: `student-${studentId}`, role_name: "owner", rank_no: 1, contribution_ratio: 1 }]
        })
      );
      studentId += 1;
    }

    await conn.execute(
      `INSERT INTO audit_task (academic_year_id, rule_node_id, audit_role, assignee_id, scope_type, scope_value, status)
       VALUES (?, NULL, 'class_committee', 1, 'all', 'all', 'active')`,
      [year.id]
    );

    return { academicYearId: year.id, snapshotId: year.current_snapshot_id, applicationIds: created };
  });
}

async function applyAuditAction(applicationId, body) {
  const action = body.action;
  const auditorId = Number(body.auditor_id || body.auditorId || 1);
  const auditRole = body.audit_role || body.auditRole || "class_committee";
  const comment = body.comment || "";

  if (!["approve", "reject", "return"].includes(action)) {
    const error = new Error("审核动作不合法");
    error.status = 400;
    throw error;
  }

  return transaction(async (conn) => {
    const [apps] = await conn.execute(
      `SELECT a.*, n.id AS node_id
       FROM application_record a
       JOIN rule_node n ON n.id = a.rule_node_id
       WHERE a.id = ? FOR UPDATE`,
      [applicationId]
    );
    const app = apps[0];
    if (!app) {
      const error = new Error("申报记录不存在");
      error.status = 404;
      throw error;
    }

    await conn.execute(
      `INSERT INTO application_audit_record (application_id, auditor_id, audit_role, audit_result, audit_comment)
       VALUES (?, ?, ?, ?, ?)`,
      [applicationId, auditorId, auditRole, action === "approve" ? "approved" : action === "reject" ? "rejected" : "returned", comment]
    );

    if (action === "return") {
      await conn.execute(
        `UPDATE application_record
         SET status = 'returned', audit_stage = 'class_review', current_auditor_role = NULL,
             returned_at = NOW(), returned_by = ?, return_reason = ?
         WHERE id = ?`,
        [auditorId, comment, applicationId]
      );
      await logApplicationOperation(conn, applicationId, auditorId, "return", { comment });
    return { id: applicationId, academicYearId: app.academic_year_id, status: "returned" };
    }

    if (action === "reject") {
      await conn.execute(
        `UPDATE application_record
         SET status = 'rejected', audit_stage = 'final', current_auditor_role = NULL,
             rejected_at = NOW(), rejected_by = ?, reject_reason = ?
         WHERE id = ?`,
        [auditorId, comment, applicationId]
      );
      await logApplicationOperation(conn, applicationId, auditorId, "reject", { comment });
      return { id: applicationId, academicYearId: app.academic_year_id, status: "rejected" };
    }

    const [requirements] = await conn.execute(
      `SELECT need_second_audit
       FROM audit_requirement
       WHERE node_id = ?`,
      [app.rule_node_id]
    );
    const needsSecondAudit = requirements.some((row) => row.need_second_audit) && auditRole !== "college_admin";
    if (needsSecondAudit) {
      await conn.execute(
        `UPDATE application_record
         SET status = 'submitted', audit_stage = 'college_review', current_auditor_role = 'college_admin'
         WHERE id = ?`,
        [applicationId]
      );
      await logApplicationOperation(conn, applicationId, auditorId, "approve", { comment, next_stage: "college_review" });
      return { id: applicationId, academicYearId: app.academic_year_id, status: "submitted", audit_stage: "college_review" };
    }

    await conn.execute(
      `UPDATE application_record
       SET status = 'approved', audit_stage = 'final', current_auditor_role = NULL,
           approved_at = NOW(), approved_by = ?
       WHERE id = ?`,
      [auditorId, applicationId]
    );
    await logApplicationOperation(conn, applicationId, auditorId, "approve", { comment, final: true });
    return { id: applicationId, academicYearId: app.academic_year_id, status: "approved" };
  });
}

async function getFieldMap(applicationId, conn) {
  const [rows] = await conn.execute(
    `SELECT field_key, field_value
     FROM application_field_value
     WHERE application_id = ?`,
    [applicationId]
  );
  const map = new Map();
  for (const row of rows) {
    map.set(row.field_key, parseJsonCell(row.field_value, row.field_value));
  }
  return map;
}

function scoreFromLevel(config, fields) {
  if (!config?.levels?.length) return null;
  const values = [...fields.values()].map(String);
  const level = config.levels.find((item) => values.includes(String(item.name)));
  if (!level) return null;
  let score = toNumber(level.score);
  if (config.weights?.length) {
    const weight = config.weights.find((item) => values.includes(String(item.name)));
    if (weight) score *= toNumber(weight.weight, 1);
  }
  return score;
}

function scoreFromPositionFormula(config, fields) {
  const positionName = fields.get("position_name");
  const weight = toNumber(fields.get("evaluation_weight"), 1);
  const base = config?.base_scores?.find((item) => String(item.name) === String(positionName));
  if (!base) return null;
  return toNumber(base.score) * weight;
}

function calculateConfigScore(configRow, fields) {
  const config = parseJsonCell(configRow.config_json, {});
  if (configRow.config_type === "fixed") {
    return toNumber(config.score, 0);
  }
  if (configRow.formula_code === "POSITION_SCORE_BY_WEIGHT") {
    return scoreFromPositionFormula(config, fields);
  }
  return scoreFromLevel(config, fields);
}

async function runCalculation(body) {
  const year = body.academicYearId || body.academic_year_id
    ? (await query(
        `SELECT y.*, s.rule_set_version_id
         FROM academic_year y
         JOIN academic_year_rule_snapshot s ON s.id = y.current_snapshot_id
         WHERE y.id = :id`,
        { id: body.academicYearId || body.academic_year_id }
      ))[0]
    : await fetchCurrentYear();

  if (!year) {
    const error = new Error("学年不存在或未绑定规则快照");
    error.status = 404;
    throw error;
  }

  return transaction(async (conn) => {
    const [batchResult] = await conn.execute(
      `INSERT INTO score_calculation_batch
       (academic_year_id, snapshot_id, batch_type, trigger_reason, status, created_by)
       VALUES (?, ?, ?, ?, 'running', ?)`,
      [year.id, year.current_snapshot_id, body.batchType || "formal", body.triggerReason || "manual", body.createdBy || 1]
    );
    const batchId = batchResult.insertId;
    await conn.execute(
      `INSERT INTO calculation_task (batch_id, academic_year_id, task_type, status, started_at)
       VALUES (?, ?, 'full', 'running', NOW())`,
      [batchId, year.id]
    );

    const [nodes] = await conn.execute(
      `SELECT *
       FROM rule_node
       WHERE rule_set_version_id = ?
       ORDER BY id`,
      [year.rule_set_version_id]
    );
    const nodeMap = new Map(nodes.map((node) => [node.id, node]));
    const childrenByParent = new Map();
    for (const node of nodes) {
      if (!childrenByParent.has(node.parent_id || 0)) childrenByParent.set(node.parent_id || 0, []);
      childrenByParent.get(node.parent_id || 0).push(node);
    }
    const depthMap = new Map();
    function depth(node) {
      if (depthMap.has(node.id)) return depthMap.get(node.id);
      const value = node.parent_id && nodeMap.has(node.parent_id) ? depth(nodeMap.get(node.parent_id)) + 1 : 0;
      depthMap.set(node.id, value);
      return value;
    }
    nodes.forEach(depth);

    const currentNodeByCode = new Map(nodes.map((node) => [node.code, node]));

    const [apps] = await conn.execute(
      `SELECT a.*, old_node.code AS original_rule_code
       FROM application_record a
       JOIN rule_node old_node ON old_node.id = a.rule_node_id
       WHERE a.academic_year_id = ?
         AND a.status = 'approved'
       ORDER BY a.student_id, a.id`,
      [year.id]
    );

    const itemScoresByStudent = new Map();
    for (const app of apps) {
      const currentNode = currentNodeByCode.get(app.original_rule_code);
      const calculationNodeId = currentNode?.id || app.rule_node_id;
      if (!currentNode) {
        await conn.execute(
          `INSERT INTO calculation_warning
           (batch_id, student_id, application_id, rule_node_id, warning_type, warning_message, severity)
           VALUES (?, ?, ?, ?, 'rule_item_not_in_current_snapshot', 'The application rule item is not present in the current rule snapshot.', 'warning')`,
          [batchId, app.student_id, app.id, app.rule_node_id]
        );
      }
      const [configs] = await conn.execute(
        `SELECT * FROM rule_calculation_config WHERE node_id = ? ORDER BY sort_order, id`,
        [calculationNodeId]
      );
      const fields = await getFieldMap(app.id, conn);
      let rawScore = null;
      const detail = { fields: Object.fromEntries(fields), configs: configs.map((row) => row.config_type) };
      for (const config of configs) {
        const score = calculateConfigScore(config, fields);
        if (score !== null && score !== undefined) rawScore = rawScore === null ? score : Math.max(rawScore, score);
      }
      if (rawScore === null) {
        rawScore = 0;
        await conn.execute(
          `INSERT INTO calculation_error
           (batch_id, student_id, application_id, rule_node_id, error_type, error_message)
           VALUES (?, ?, ?, ?, 'missing_score_config', 'No matching scoring config was found.')`,
          [batchId, app.student_id, app.id, calculationNodeId]
        );
      }
      rawScore = Number(rawScore.toFixed(3));
      await conn.execute(
        `INSERT INTO score_item_result
         (batch_id, application_id, student_id, rule_node_id, score_source_type, raw_score, effective_score, calculation_detail_json)
         VALUES (?, ?, ?, ?, 'application', ?, ?, ?)`,
        [batchId, app.id, app.student_id, calculationNodeId, rawScore, rawScore, JSON.stringify({ ...detail, original_rule_code: app.original_rule_code })]
      );
      if (!itemScoresByStudent.has(app.student_id)) itemScoresByStudent.set(app.student_id, new Map());
      const nodeScores = itemScoresByStudent.get(app.student_id);
      if (!nodeScores.has(calculationNodeId)) nodeScores.set(calculationNodeId, []);
      nodeScores.get(calculationNodeId).push(rawScore);
    }

    const totalRows = [];
    for (const [studentId, itemScores] of itemScoresByStudent.entries()) {
      const resultByNode = new Map();
      const reverseNodes = [...nodes].sort((a, b) => depthMap.get(b.id) - depthMap.get(a.id));
      for (const node of reverseNodes) {
        const ownScores = itemScores.get(node.id) || [];
        const childResults = (childrenByParent.get(node.id) || []).map((child) => resultByNode.get(child.id)).filter(Boolean);
        const inputs = [...ownScores, ...childResults.map((row) => row.effective)];
        let raw = inputs.reduce((sum, value) => sum + toNumber(value), 0);
        let effective = raw;
        if (node.aggregation_type === "max") {
          raw = inputs.length ? Math.max(...inputs.map(toNumber)) : 0;
          effective = raw;
        }
        if (node.aggregation_type === "cap" && node.max_score !== null && node.max_score !== undefined) {
          effective = Math.min(raw, toNumber(node.max_score));
        }
        raw = Number(raw.toFixed(3));
        effective = Number(effective.toFixed(3));
        if (raw !== 0 || effective !== 0 || !node.parent_id) {
          await conn.execute(
            `INSERT INTO score_node_result
             (batch_id, academic_year_id, student_id, rule_node_id, raw_score, effective_score, applied_rule_json)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              batchId,
              year.id,
              studentId,
              node.id,
              raw,
              effective,
              JSON.stringify({ aggregation_type: node.aggregation_type, max_score: node.max_score, input_count: inputs.length })
            ]
          );
          if (raw > effective) {
            await conn.execute(
              `INSERT INTO calculation_warning
               (batch_id, student_id, rule_node_id, warning_type, warning_message, severity)
               VALUES (?, ?, ?, 'cap_applied', ?, 'info')`,
              [batchId, studentId, node.id, `Raw score ${raw} was capped to ${effective}.`]
            );
          }
        }
        resultByNode.set(node.id, { raw, effective });
      }
      const root = nodes.find((node) => !node.parent_id);
      const totalScore = root ? resultByNode.get(root.id)?.effective || 0 : [...resultByNode.values()].reduce((sum, row) => sum + row.effective, 0);
      totalRows.push({ studentId, totalScore: Number(totalScore.toFixed(3)) });
    }

    totalRows.sort((a, b) => b.totalScore - a.totalScore || a.studentId - b.studentId);
    for (let index = 0; index < totalRows.length; index++) {
      const row = totalRows[index];
      await conn.execute(
        `INSERT INTO score_total_result
         (batch_id, academic_year_id, student_id, rank_scope_type, rank_scope_value, total_score, rank_no, status)
         VALUES (?, ?, ?, 'college', 'all', ?, ?, 'calculated')`,
        [batchId, year.id, row.studentId, row.totalScore, index + 1]
      );
    }

    await conn.execute(
      `UPDATE calculation_task
       SET status = 'succeeded', finished_at = NOW()
       WHERE batch_id = ?`,
      [batchId]
    );
    await conn.execute(
      `UPDATE score_calculation_batch
       SET status = 'succeeded', finished_at = NOW()
       WHERE id = ?`,
      [batchId]
    );

    return { batchId, academicYearId: year.id, calculatedStudents: totalRows.length, approvedApplications: apps.length };
  });
}

async function handleAuditCalculationApi(req, res, context) {
  const { parts, method, url, ok, fail, readJson } = context;

  if (method === "POST" && parts.join("/") === "api/dev/seed-audit-calculation") {
    const data = await seedAuditCalculationDemo();
    return ok(res, data, "审核与核算示例申报已创建");
  }

  if (method === "GET" && parts.join("/") === "api/audit/applications") {
    const status = url.searchParams.get("status") || "submitted";
    const rows = await query(
      `SELECT a.id, a.academic_year_id, a.student_id, a.title, a.status, a.audit_stage,
              a.current_auditor_role, a.submitted_at, a.approved_at, a.returned_at,
              n.name AS rule_name, n.code AS rule_code
       FROM application_record a
       JOIN rule_node n ON n.id = a.rule_node_id
       WHERE (:status = 'all' OR a.status = :status)
       ORDER BY a.submitted_at DESC, a.id DESC`,
      { status }
    );
    return ok(res, rows);
  }

  if (method === "GET" && parts[0] === "api" && parts[1] === "audit" && parts[2] === "applications" && parts.length === 4) {
    const detail = await fetchApplicationDetail(Number(parts[3]));
    return ok(res, detail);
  }

  if (method === "POST" && parts[0] === "api" && parts[1] === "audit" && parts[2] === "applications" && parts[4] === "actions") {
    const body = await readJson(req);
    const data = await applyAuditAction(Number(parts[3]), body);
    if (data.status === "approved") {
      data.auto_calculation = await runCalculation({
        academicYearId: data.academicYearId,
        batchType: "auto",
        triggerReason: `application_approved:${data.id}`,
        createdBy: body.auditor_id || body.auditorId || 1
      });
    }
    return ok(res, data, "审核动作已执行");
  }

  if (method === "POST" && parts.join("/") === "api/audit/batch") {
    const body = await readJson(req);
    const applicationIds = body.application_ids || body.applicationIds || [];
    const results = [];
    for (const id of applicationIds) {
      results.push(await applyAuditAction(Number(id), body));
    }
    const approvedResults = results.filter((result) => result.status === "approved");
    let autoCalculation = null;
    if (approvedResults.length) {
      autoCalculation = await runCalculation({
        academicYearId: approvedResults[0].academicYearId,
        batchType: "auto",
        triggerReason: `batch_application_approved:${approvedResults.map((result) => result.id).join(",")}`,
        createdBy: body.auditor_id || body.auditorId || 1
      });
    }
    if (applicationIds.length) {
      await query(
        `INSERT INTO audit_batch (academic_year_id, audit_role, action, operator_id, application_count, comment)
         VALUES (:academicYearId, :auditRole, :action, :operatorId, :applicationCount, :comment)`,
        {
          academicYearId: body.academic_year_id || body.academicYearId || 0,
          auditRole: body.audit_role || body.auditRole || "class_committee",
          action: body.action,
          operatorId: body.auditor_id || body.auditorId || 1,
          applicationCount: applicationIds.length,
          comment: body.comment || null
        }
      );
    }
    return ok(res, { results, auto_calculation: autoCalculation }, "批量审核已完成");
  }

  if (method === "POST" && parts[0] === "api" && parts[1] === "audit" && parts[2] === "attachments" && parts[4] === "review") {
    const attachmentId = Number(parts[3]);
    const body = await readJson(req);
    const reviewerId = Number(body.reviewer_id || body.reviewerId || 1);
    const reviewResult = body.review_result || body.reviewResult || "valid";
    const reviewComment = body.review_comment || body.reviewComment || null;
    await transaction(async (conn) => {
      await conn.execute(
        `INSERT INTO attachment_review_record (attachment_id, reviewer_id, review_result, review_comment)
         VALUES (?, ?, ?, ?)`,
        [attachmentId, reviewerId, reviewResult, reviewComment]
      );
      await conn.execute(
        `UPDATE application_attachment
         SET review_result = ?, review_comment = ?
         WHERE id = ?`,
        [reviewResult, reviewComment, attachmentId]
      );
    });
    return ok(res, { id: attachmentId }, "材料审核已保存");
  }

  if (method === "POST" && parts.join("/") === "api/calculation/run") {
    const body = await readJson(req);
    const data = await runCalculation(body);
    return ok(res, data, "核算已完成");
  }

  if (method === "GET" && parts.join("/") === "api/calculation/batches") {
    const rows = await query(
      `SELECT b.*,
              COUNT(t.id) AS result_count
       FROM score_calculation_batch b
       LEFT JOIN score_total_result t ON t.batch_id = b.id
       GROUP BY b.id
       ORDER BY b.created_at DESC, b.id DESC
       LIMIT 20`
    );
    return ok(res, rows);
  }

  if (method === "GET" && parts[0] === "api" && parts[1] === "calculation" && parts[2] === "batches" && parts[4] === "results") {
    const batchId = Number(parts[3]);
    const rows = await query(
      `SELECT *
       FROM score_total_result
       WHERE batch_id = :batchId
       ORDER BY rank_no, total_score DESC`,
      { batchId }
    );
    return ok(res, rows);
  }

  if (method === "GET" && parts[0] === "api" && parts[1] === "calculation" && parts[2] === "batches" && parts[4] === "students") {
    const batchId = Number(parts[3]);
    const studentId = Number(parts[5]);
    const [items, nodes, warnings, errors] = await Promise.all([
      query(
        `SELECT r.*, n.name AS rule_name, n.code AS rule_code
         FROM score_item_result r
         JOIN rule_node n ON n.id = r.rule_node_id
         WHERE r.batch_id = :batchId AND r.student_id = :studentId
         ORDER BY r.id`,
        { batchId, studentId }
      ),
      query(
        `SELECT r.*, n.name AS node_name, n.code AS node_code, n.node_type
         FROM score_node_result r
         JOIN rule_node n ON n.id = r.rule_node_id
         WHERE r.batch_id = :batchId AND r.student_id = :studentId
         ORDER BY n.sort_order, n.id`,
        { batchId, studentId }
      ),
      query(`SELECT * FROM calculation_warning WHERE batch_id = :batchId AND student_id = :studentId ORDER BY id`, { batchId, studentId }),
      query(`SELECT * FROM calculation_error WHERE batch_id = :batchId AND student_id = :studentId ORDER BY id`, { batchId, studentId })
    ]);
    return ok(res, { items: normalizeRows(items), nodes: normalizeRows(nodes), warnings, errors });
  }

  return false;
}

export { handleAuditCalculationApi, runCalculation };
