import { query, transaction } from "./db.js";
import { buildXlsx } from "./xlsxLite.js";
import { logOperation } from "./systemManagement.js";

// 负责结果查询、xlsx 导出和公示生命周期。公示会复制指定核算批次，
// 避免后续重算导致已经发布的公示结果发生漂移。

function makeError(status, message, details = undefined) {
  const error = new Error(message);
  error.status = status;
  error.details = details;
  return error;
}

function parseJsonCell(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function latestBatch(academicYearId = null) {
  const rows = await query(
    `SELECT *
     FROM score_calculation_batch
     WHERE status = 'succeeded'
       AND (:academicYearId IS NULL OR academic_year_id = :academicYearId)
     ORDER BY finished_at DESC, created_at DESC, id DESC
     LIMIT 1`,
    { academicYearId: academicYearId ? Number(academicYearId) : null }
  );
  return rows[0] || null;
}

async function requireBatch(academicYearId = null, batchId = null) {
  if (batchId) {
    const [batch] = await query(`SELECT * FROM score_calculation_batch WHERE id = :batchId`, { batchId: Number(batchId) });
    if (!batch) throw makeError(404, "核算批次不存在");
    return batch;
  }
  const batch = await latestBatch(academicYearId);
  if (!batch) throw makeError(409, "暂无可用核算结果，请先完成核算");
  return batch;
}

async function resultRows(batchId) {
  return query(
    `SELECT t.*, y.name AS academic_year_name,
            COALESCE(s.student_no, CAST(t.student_id AS CHAR)) AS student_no,
            COALESCE(s.name, CONCAT('学生', t.student_id)) AS student_name,
            s.grade, s.major,
            COALESCE(s.class_name, s.administrative_class, '未维护班级') AS class_name
     FROM score_total_result t
     JOIN academic_year y ON y.id = t.academic_year_id
     LEFT JOIN student_profile s ON s.id = t.student_id OR CAST(s.student_no AS UNSIGNED) = t.student_id
     WHERE t.batch_id = :batchId
     ORDER BY t.rank_no, t.total_score DESC, t.student_id`,
    { batchId }
  );
}

async function getLatestResults(url) {
  const academicYearId = url.searchParams.get("academicYearId") || url.searchParams.get("academic_year_id");
  const batchId = url.searchParams.get("batchId") || url.searchParams.get("batch_id");
  const batch = await requireBatch(academicYearId, batchId);
  const rows = await resultRows(batch.id);
  return { batch, rows };
}

async function classStatistics(url) {
  const academicYearId = url.searchParams.get("academicYearId") || url.searchParams.get("academic_year_id");
  const batchId = url.searchParams.get("batchId") || url.searchParams.get("batch_id");
  const grade = url.searchParams.get("grade") || "";
  const major = url.searchParams.get("major") || "";
  const batch = await requireBatch(academicYearId, batchId);
  const rows = await query(
    `SELECT COALESCE(s.grade, '未维护年级') AS grade,
            COALESCE(s.major, '未维护专业') AS major,
            COALESCE(s.class_name, s.administrative_class, '未维护班级') AS class_name,
            COUNT(*) AS student_count,
            ROUND(AVG(t.total_score), 3) AS avg_score,
            ROUND(MAX(t.total_score), 3) AS max_score,
            ROUND(MIN(t.total_score), 3) AS min_score
     FROM score_total_result t
     LEFT JOIN student_profile s ON s.id = t.student_id OR CAST(s.student_no AS UNSIGNED) = t.student_id
     WHERE t.batch_id = :batchId
       AND (:grade = '' OR s.grade = :grade)
       AND (:major = '' OR s.major = :major)
     GROUP BY COALESCE(s.grade, '未维护年级'), COALESCE(s.major, '未维护专业'), COALESCE(s.class_name, s.administrative_class, '未维护班级')
     ORDER BY grade DESC, major, avg_score DESC`,
    { batchId: batch.id, grade, major }
  );
  const summary = rows.reduce(
    (acc, row) => {
      acc.class_count += 1;
      acc.student_count += Number(row.student_count || 0);
      acc.avg_score_sum += Number(row.avg_score || 0);
      return acc;
    },
    { class_count: 0, student_count: 0, avg_score_sum: 0 }
  );
  summary.avg_of_class_avg = summary.class_count ? Number((summary.avg_score_sum / summary.class_count).toFixed(3)) : 0;
  delete summary.avg_score_sum;
  return { batch, summary, rows };
}

function xlsxPayload(fileName, rows) {
  const buffer = buildXlsx(rows);
  return {
    fileName,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    contentBase64: buffer.toString("base64")
  };
}

async function exportResults(url) {
  const academicYearId = url.searchParams.get("academicYearId") || url.searchParams.get("academic_year_id");
  const batchId = url.searchParams.get("batchId") || url.searchParams.get("batch_id");
  const batch = await requireBatch(academicYearId, batchId);
  const rows = await resultRows(batch.id);
  return xlsxPayload(`score-results-batch-${batch.id}.xlsx`, [
    ["排名", "学号", "姓名", "年级", "专业", "行政班", "总分", "状态", "核算批次"],
    ...rows.map((row) => [
      row.rank_no || "",
      row.student_no || row.student_id,
      row.student_name,
      row.grade || "",
      row.major || "",
      row.class_name || "",
      Number(row.total_score),
      row.status || "",
      batch.id
    ])
  ]);
}

async function listPublicityBatches(url) {
  const academicYearId = url.searchParams.get("academicYearId") || url.searchParams.get("academic_year_id");
  return query(
    `SELECT p.*, y.name AS academic_year_name, b.trigger_reason,
            COUNT(r.id) AS result_count
     FROM publicity_batch p
     JOIN academic_year y ON y.id = p.academic_year_id
     JOIN score_calculation_batch b ON b.id = p.calculation_batch_id
     LEFT JOIN publicity_result r ON r.publicity_batch_id = p.id
     WHERE (:academicYearId IS NULL OR p.academic_year_id = :academicYearId)
     GROUP BY p.id
     ORDER BY p.created_at DESC, p.id DESC`,
    { academicYearId: academicYearId ? Number(academicYearId) : null }
  );
}

async function publicityStatus(url) {
  const academicYearId = url.searchParams.get("academicYearId") || url.searchParams.get("academic_year_id");
  const rows = await query(
    `SELECT p.*, y.name AS academic_year_name
     FROM publicity_batch p
     JOIN academic_year y ON y.id = p.academic_year_id
     WHERE (:academicYearId IS NULL OR p.academic_year_id = :academicYearId)
     ORDER BY FIELD(p.status, 'publicizing', 'draft', 'closed', 'archived'), p.created_at DESC
     LIMIT 1`,
    { academicYearId: academicYearId ? Number(academicYearId) : null }
  );
  return rows[0] || null;
}

async function startPublicity(body, ipAddress) {
  // 将选定核算结果固化到 publicity_result；后续统计可以继续变化，
  // 但已经发布的公示批次始终可以原样复现。
  const academicYearId = Number(body.academic_year_id || body.academicYearId);
  if (!academicYearId) throw makeError(400, "请选择学年");
  const batch = await requireBatch(academicYearId, body.batch_id || body.batchId);
  const initiatorRole = body.initiator_role || body.initiatorRole || "class_committee";
  const createdBy = body.created_by || body.createdBy || 1;

  return transaction(async (conn) => {
    const [activeRows] = await conn.execute(
      `SELECT id FROM publicity_batch WHERE academic_year_id = ? AND status = 'publicizing' LIMIT 1`,
      [academicYearId]
    );
    if (activeRows.length) throw makeError(409, "该学年已有正在公示的批次，请先结束公示");

    const [roundRows] = await conn.execute(
      `SELECT COALESCE(MAX(publicity_round), 0) + 1 AS next_round FROM publicity_batch WHERE academic_year_id = ?`,
      [academicYearId]
    );
    const nextRound = Number(roundRows[0].next_round || 1);
    const [publicity] = await conn.execute(
      `INSERT INTO publicity_batch
       (academic_year_id, calculation_batch_id, publicity_round, start_time, end_time, status, created_by)
       VALUES (?, ?, ?, NOW(), ?, 'publicizing', ?)`,
      [academicYearId, batch.id, nextRound, body.end_time || body.endTime || null, createdBy]
    );

    const [results] = await conn.execute(
      `SELECT *
       FROM score_total_result
       WHERE batch_id = ?
       ORDER BY rank_no, total_score DESC`,
      [batch.id]
    );
    for (const result of results) {
      await conn.execute(
        `INSERT INTO publicity_result
         (publicity_batch_id, student_id, total_score, rank_no, detail_snapshot_json)
         VALUES (?, ?, ?, ?, ?)`,
        [
          publicity.insertId,
          result.student_id,
          result.total_score,
          result.rank_no,
          JSON.stringify({
            batch_id: batch.id,
            academic_year_id: academicYearId,
            rank_scope_type: result.rank_scope_type,
            rank_scope_value: result.rank_scope_value,
            status: result.status
          })
        ]
      );
    }

    await conn.execute(
      `UPDATE academic_year
       SET status = 'publicizing', publicity_start_time = NOW(), publicity_end_time = ?
       WHERE id = ?`,
      [body.end_time || body.endTime || null, academicYearId]
    );

    await logOperation(conn, {
      module: "result",
      operationType: "start_publicity",
      targetType: "publicity_batch",
      targetId: publicity.insertId,
      operationDetail: { initiatorRole, academicYearId, batchId: batch.id, resultCount: results.length },
      ipAddress
    });

    return { id: publicity.insertId, publicityRound: nextRound, resultCount: results.length, initiatorRole };
  });
}

async function endPublicity(publicityId, body, ipAddress) {
  const operatorId = body.operator_id || body.operatorId || 1;
  return transaction(async (conn) => {
    const [rows] = await conn.execute(`SELECT * FROM publicity_batch WHERE id = ? FOR UPDATE`, [publicityId]);
    const publicity = rows[0];
    if (!publicity) throw makeError(404, "公示批次不存在");
    await conn.execute(
      `UPDATE publicity_batch SET status = 'closed', end_time = NOW() WHERE id = ?`,
      [publicityId]
    );
    await conn.execute(
      `UPDATE academic_year
       SET status = 'appealing', publicity_end_time = NOW()
       WHERE id = ?`,
      [publicity.academic_year_id]
    );
    await logOperation(conn, {
      operatorId,
      module: "result",
      operationType: "end_publicity",
      targetType: "publicity_batch",
      targetId: publicityId,
      operationDetail: { academicYearId: publicity.academic_year_id },
      ipAddress
    });
    return { id: publicityId, status: "closed" };
  });
}

async function publicityResults(publicityId) {
  const [batch] = await query(`SELECT * FROM publicity_batch WHERE id = :publicityId`, { publicityId });
  if (!batch) throw makeError(404, "公示批次不存在");
  const rows = await query(
    `SELECT r.*, COALESCE(s.student_no, CAST(r.student_id AS CHAR)) AS student_no,
            COALESCE(s.name, CONCAT('学生', r.student_id)) AS student_name,
            s.grade, s.major, COALESCE(s.class_name, s.administrative_class, '未维护班级') AS class_name
     FROM publicity_result r
     LEFT JOIN student_profile s ON s.id = r.student_id OR CAST(s.student_no AS UNSIGNED) = r.student_id
     WHERE r.publicity_batch_id = :publicityId
     ORDER BY r.rank_no, r.total_score DESC`,
    { publicityId }
  );
  return { batch, rows: rows.map((row) => ({ ...row, detail_snapshot_json: parseJsonCell(row.detail_snapshot_json, {}) })) };
}

async function handleResultManagementApi(req, res, context) {
  const { parts, method, url, ok, readJson } = context;
  const ipAddress = req.socket.remoteAddress;

  if (method === "GET" && parts.join("/") === "api/results/latest") return ok(res, await getLatestResults(url));
  if (method === "GET" && parts.join("/") === "api/results/statistics/classes") return ok(res, await classStatistics(url));
  if (method === "GET" && parts.join("/") === "api/results/export") return ok(res, await exportResults(url));
  if (method === "GET" && parts.join("/") === "api/results/publicity/batches") return ok(res, await listPublicityBatches(url));
  if (method === "GET" && parts.join("/") === "api/results/publicity/status") return ok(res, await publicityStatus(url));
  if (method === "POST" && parts.join("/") === "api/results/publicity/start") {
    return ok(res, await startPublicity(await readJson(req), ipAddress), "公示已发起");
  }
  if (method === "POST" && parts[0] === "api" && parts[1] === "results" && parts[2] === "publicity" && parts[4] === "end") {
    return ok(res, await endPublicity(Number(parts[3]), await readJson(req), ipAddress), "公示已结束");
  }
  if (method === "GET" && parts[0] === "api" && parts[1] === "results" && parts[2] === "publicity" && parts[4] === "results") {
    return ok(res, await publicityResults(Number(parts[3])));
  }

  return false;
}

export { handleResultManagementApi };
