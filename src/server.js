import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool, query, transaction, jsonParam } from "./db.js";
import { handleAuditCalculationApi, runCalculation } from "./auditCalculation.js";
import { handleApplicationSubmissionApi } from "./applicationSubmission.js";
import { handleResultManagementApi } from "./resultManagement.js";
import { handleSystemManagementApi, logOperation } from "./systemManagement.js";
import { seedDefaultRuleSet } from "./defaultRuleSet.js";

// 应用入口：负责 HTTP 路由、规则/学年生命周期和静态文件等跨模块能力。
// 申报、审核核算、结果和系统管理等具体业务分别放在独立模块中。

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const uploadDir = path.join(rootDir, "uploads");
const port = Number(process.env.PORT || 5173);
const host = process.env.BIND_HOST || process.env.HOST || "0.0.0.0";

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(body));
}

function ok(res, data = null, message = "ok") {
  sendJson(res, 200, { code: 200, message, data });
}

function fail(res, status, message, details) {
  sendJson(res, status, { code: status, message, details });
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function parseRoute(req) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const parts = url.pathname.split("/").filter(Boolean);
  return { url, parts };
}

function toNullableDecimal(value) {
  if (value === undefined || value === null || value === "") return null;
  return Number(value);
}

function toBool(value) {
  return value === true || value === 1 || value === "1";
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeRuleNodeType(value) {
  // 兼容仍在发送旧固定层级类型的接口调用；入库前统一转换为 aggregate，
  // 使规则层级只由 parent_id 决定。
  if (["aggregate", "total", "module", "category", "subcategory"].includes(value)) {
    return "aggregate";
  }
  if (value === "item") return "item";
  throw httpError(400, "节点类型只能是 aggregate（汇总节点）或 item（规则项）");
}

function normalizeParentId(value) {
  if (value === undefined || value === null || value === "") return null;
  const parentId = Number(value);
  if (!Number.isInteger(parentId) || parentId <= 0) {
    throw httpError(400, "父节点 ID 不合法");
  }
  return parentId;
}

async function validateRuleNodeStructure({ versionId, nodeId = null, parentId, nodeType, isApplyEntry }) {
  // 外键负责保护数据引用，下面的校验负责保护单行约束无法表达的树结构语义。
  const normalizedType = normalizeRuleNodeType(nodeType);

  if (normalizedType === "aggregate" && isApplyEntry) {
    throw httpError(400, "汇总节点不能作为申报入口，请新建下级规则项");
  }
  if (normalizedType === "item" && parentId === null) {
    throw httpError(400, "规则项不能作为根节点，必须挂在汇总节点下");
  }

  const [version] = await query("SELECT id FROM rule_set_version WHERE id = :versionId", { versionId });
  if (!version) throw httpError(404, "规则版本不存在");

  if (parentId === null) {
    const [existingRoot] = await query(
      `SELECT id FROM rule_node
       WHERE rule_set_version_id = :versionId
         AND parent_id IS NULL
         AND (:nodeId IS NULL OR id <> :nodeId)
       LIMIT 1`,
      { versionId, nodeId }
    );
    if (existingRoot) throw httpError(409, "每个规则版本只能有一个根节点");
  } else {
    if (nodeId !== null && parentId === nodeId) {
      throw httpError(400, "节点不能把自己设为父节点");
    }
    const [parent] = await query(
      `SELECT id, rule_set_version_id, node_type FROM rule_node WHERE id = :parentId`,
      { parentId }
    );
    if (!parent) throw httpError(400, "父节点不存在");
    if (Number(parent.rule_set_version_id) !== Number(versionId)) {
      throw httpError(400, "父节点必须属于同一个规则版本");
    }
    if (normalizeRuleNodeType(parent.node_type) !== "aggregate") {
      throw httpError(400, "规则项不能包含子节点，请选择汇总节点作为父节点");
    }

    if (nodeId !== null) {
      const [cycle] = await query(
        `WITH RECURSIVE descendants AS (
           SELECT id FROM rule_node WHERE parent_id = :nodeId
           UNION ALL
           SELECT n.id FROM rule_node n JOIN descendants d ON n.parent_id = d.id
         )
         SELECT id FROM descendants WHERE id = :parentId LIMIT 1`,
        { nodeId, parentId }
      );
      if (cycle) throw httpError(400, "不能把节点移动到自己的下级，规则树不允许成环");
    }
  }

  if (nodeId !== null && normalizedType === "item") {
    const [child] = await query("SELECT id FROM rule_node WHERE parent_id = :nodeId LIMIT 1", { nodeId });
    if (child) throw httpError(409, "仍有子节点，不能将该节点改为规则项");
  }

  return normalizedType;
}

function clientIp(req) {
  return req.socket.remoteAddress;
}

async function requireSuperAdmin(conn, req) {
  // 当前原型尚未接入登录会话，因此根据操作者 ID 查询 system_user，
  // 不直接信任浏览器传入的角色字符串。
  const operatorId = Number(req.headers["x-operator-id"]);
  if (!Number.isInteger(operatorId) || operatorId <= 0) {
    throw httpError(403, "彻底删除学年需要提供最高管理员用户 ID");
  }
  const [operator] = await conn.execute(
    `SELECT id, username, display_name, role, status
     FROM system_user
     WHERE id = ?`,
    [operatorId]
  );
  const user = operator[0];
  if (!user || user.status !== "active" || user.role !== "super_admin") {
    throw httpError(403, "只有状态正常的最高管理员可以彻底删除学年");
  }
  return user;
}

async function deleteRuleNode(nodeId, req) {
  // 仅当整棵配置子树未被申报或历史成绩引用时才允许删除，
  // 已被使用的规则必须保留，确保历史成绩仍然可以解释和追溯。
  return transaction(async (conn) => {
    const [nodeRows] = await conn.execute(
      `SELECT id, rule_set_version_id, code, name FROM rule_node WHERE id = ?`,
      [nodeId]
    );
    const node = nodeRows[0];
    if (!node) throw httpError(404, "规则节点不存在");

    const [subtree] = await conn.execute(
      `WITH RECURSIVE nodes AS (
         SELECT id, parent_id, 0 AS depth FROM rule_node WHERE id = ?
         UNION ALL
         SELECT n.id, n.parent_id, nodes.depth + 1
         FROM rule_node n
         JOIN nodes ON n.parent_id = nodes.id
       )
       SELECT id, depth FROM nodes ORDER BY depth DESC, id DESC`,
      [nodeId]
    );
    const nodeIds = subtree.map((row) => Number(row.id));
    const placeholders = nodeIds.map(() => "?").join(",");
    const [usageRows] = await conn.execute(
      `SELECT
         (SELECT COUNT(*) FROM application_record WHERE rule_node_id IN (${placeholders})) AS application_count,
         (SELECT COUNT(*) FROM score_item_result WHERE rule_node_id IN (${placeholders})) AS item_result_count,
         (SELECT COUNT(*) FROM score_node_result WHERE rule_node_id IN (${placeholders})) AS node_result_count`,
      [...nodeIds, ...nodeIds, ...nodeIds]
    );
    const usage = usageRows[0];
    const used = Object.values(usage).some((value) => Number(value) > 0);
    if (used) {
      throw httpError(409, "该节点或其下级已有申报/核算数据，不能删除；请新建规则版本后调整");
    }

    const [yearRows] = await conn.execute(
      `SELECT y.id
       FROM academic_year y
       JOIN academic_year_rule_snapshot s ON s.id = y.current_snapshot_id
       WHERE s.rule_set_version_id = ?`,
      [node.rule_set_version_id]
    );

    for (const row of subtree) {
      await conn.execute("DELETE FROM rule_node WHERE id = ?", [row.id]);
    }
    await logOperation(conn, {
      module: "rule",
      operationType: "delete_rule_node_subtree",
      targetType: "rule_node",
      targetId: nodeId,
      operationDetail: { code: node.code, name: node.name, deleted_node_count: subtree.length },
      ipAddress: clientIp(req)
    });
    return {
      id: nodeId,
      deleted_node_count: subtree.length,
      affected_academic_year_ids: yearRows.map((row) => Number(row.id))
    };
  });
}

async function deleteRuleSetConfigTree(conn, ruleSetId) {
  // 规则节点表 rule_node 使用自引用 RESTRICT 外键，物理删除未使用规则集时，
  // 必须先删除下级节点，再删除父节点。
  const [versions] = await conn.execute("SELECT id FROM rule_set_version WHERE rule_set_id = ?", [ruleSetId]);
  const versionIds = versions.map((row) => Number(row.id));
  if (!versionIds.length) {
    return { version_count: 0, node_count: 0 };
  }

  const placeholders = versionIds.map(() => "?").join(",");
  const [nodes] = await conn.execute(
    `SELECT id, parent_id FROM rule_node WHERE rule_set_version_id IN (${placeholders})`,
    versionIds
  );

  const nodeMap = new Map(
    nodes.map((row) => [
      Number(row.id),
      {
        id: Number(row.id),
        parentId: row.parent_id === null ? null : Number(row.parent_id)
      }
    ])
  );
  const depthMemo = new Map();
  const depthOf = (nodeId) => {
    if (depthMemo.has(nodeId)) return depthMemo.get(nodeId);
    const node = nodeMap.get(nodeId);
    if (!node || !node.parentId || !nodeMap.has(node.parentId)) {
      depthMemo.set(nodeId, 0);
      return 0;
    }
    const depth = depthOf(node.parentId) + 1;
    depthMemo.set(nodeId, depth);
    return depth;
  };

  const nodeIdsByDepthDesc = nodes
    .map((row) => Number(row.id))
    .sort((a, b) => depthOf(b) - depthOf(a));

  for (const nodeId of nodeIdsByDepthDesc) {
    await conn.execute("DELETE FROM rule_node WHERE id = ?", [nodeId]);
  }

  await conn.execute("DELETE FROM rule_set_version WHERE rule_set_id = ?", [ruleSetId]);
  return { version_count: versionIds.length, node_count: nodes.length };
}

async function deleteRuleSet(ruleSetId, req) {
  return transaction(async (conn) => {
    const [usage] = await conn.execute(
      `SELECT
         (SELECT COUNT(*) FROM academic_year_rule_snapshot s
          JOIN rule_set_version v ON v.id = s.rule_set_version_id
          WHERE v.rule_set_id = ?) AS snapshot_count,
         (SELECT COUNT(*) FROM application_record a
          JOIN rule_node n ON n.id = a.rule_node_id
          JOIN rule_set_version v ON v.id = n.rule_set_version_id
          WHERE v.rule_set_id = ?) AS application_count`,
      [ruleSetId, ruleSetId]
    );
    const used = Number(usage[0].snapshot_count) > 0 || Number(usage[0].application_count) > 0;
    if (used) {
      await conn.execute(`UPDATE rule_set SET status = 'archived' WHERE id = ?`, [ruleSetId]);
      await logOperation(conn, {
        module: "rule",
        operationType: "archive_rule_set",
        targetType: "rule_set",
        targetId: ruleSetId,
        operationDetail: usage[0],
        ipAddress: clientIp(req)
      });
      return { id: ruleSetId, archived: true, deleted: false, usage: usage[0] };
    }
    const deletedConfig = await deleteRuleSetConfigTree(conn, ruleSetId);
    await conn.execute(`DELETE FROM rule_set WHERE id = ?`, [ruleSetId]);
    await logOperation(conn, {
      module: "rule",
      operationType: "delete_rule_set",
      targetType: "rule_set",
      targetId: ruleSetId,
      operationDetail: deletedConfig,
      ipAddress: clientIp(req)
    });
    return { id: ruleSetId, archived: false, deleted: true, usage: usage[0], deleted_config: deletedConfig };
  });
}

async function deleteAcademicYear(academicYearId, req) {
  // 普通管理员使用安全删除：未使用学年可物理删除，已有业务历史的学年只归档。
  return transaction(async (conn) => {
    const [usage] = await conn.execute(
      `SELECT
         (SELECT COUNT(*) FROM application_record WHERE academic_year_id = ?) AS application_count,
         (SELECT COUNT(*) FROM score_calculation_batch WHERE academic_year_id = ?) AS calculation_count,
         (SELECT COUNT(*) FROM publicity_batch WHERE academic_year_id = ?) AS publicity_count`,
      [academicYearId, academicYearId, academicYearId]
    );
    const used = Number(usage[0].application_count) > 0 || Number(usage[0].calculation_count) > 0 || Number(usage[0].publicity_count) > 0;
    if (used) {
      await conn.execute(`UPDATE academic_year SET status = 'archived' WHERE id = ?`, [academicYearId]);
      await logOperation(conn, {
        module: "year",
        operationType: "archive_academic_year",
        targetType: "academic_year",
        targetId: academicYearId,
        operationDetail: usage[0],
        ipAddress: clientIp(req)
      });
      return { id: academicYearId, archived: true, deleted: false, usage: usage[0] };
    }
    await conn.execute(`UPDATE academic_year SET current_snapshot_id = NULL WHERE id = ?`, [academicYearId]);
    await conn.execute(`DELETE FROM academic_year_rule_snapshot WHERE academic_year_id = ?`, [academicYearId]);
    await conn.execute(`DELETE FROM academic_year WHERE id = ?`, [academicYearId]);
    await logOperation(conn, {
      module: "year",
      operationType: "delete_academic_year",
      targetType: "academic_year",
      targetId: academicYearId,
      operationDetail: {},
      ipAddress: clientIp(req)
    });
    return { id: academicYearId, archived: false, deleted: true, usage: usage[0] };
  });
}

async function forceDeleteAcademicYear(academicYearId, confirmName, req) {
  // 不可恢复的彻底删除与普通删除明确分离。数据库记录在事务中统一删除；
  // 文件系统无法参与 MySQL 回滚，因此证明材料只能在事务提交后清理。
  const result = await transaction(async (conn) => {
    const operator = await requireSuperAdmin(conn, req);
    const [yearRows] = await conn.execute("SELECT id, name FROM academic_year WHERE id = ? FOR UPDATE", [academicYearId]);
    const year = yearRows[0];
    if (!year) throw httpError(404, "学年不存在");
    if (!confirmName || confirmName !== year.name) {
      throw httpError(400, "确认名称不一致，已取消彻底删除");
    }

    const [usageRows] = await conn.execute(
      `SELECT
         (SELECT COUNT(*) FROM application_record WHERE academic_year_id = ?) AS application_count,
         (SELECT COUNT(*) FROM score_calculation_batch WHERE academic_year_id = ?) AS calculation_count,
         (SELECT COUNT(*) FROM publicity_batch WHERE academic_year_id = ?) AS publicity_count,
         (SELECT COUNT(*) FROM appeal_record a JOIN publicity_batch p ON p.id = a.publicity_batch_id WHERE p.academic_year_id = ?) AS appeal_count,
         (SELECT COUNT(*) FROM academic_year_rule_snapshot WHERE academic_year_id = ?) AS snapshot_count`,
      [academicYearId, academicYearId, academicYearId, academicYearId, academicYearId]
    );
    const usage = usageRows[0];
    const [applicationRows] = await conn.execute(
      "SELECT id FROM application_record WHERE academic_year_id = ?",
      [academicYearId]
    );

    await conn.execute(
      `DELETE a FROM appeal_record a
       JOIN publicity_batch p ON p.id = a.publicity_batch_id
       WHERE p.academic_year_id = ?`,
      [academicYearId]
    );
    await conn.execute("DELETE FROM publicity_batch WHERE academic_year_id = ?", [academicYearId]);
    await conn.execute("DELETE FROM score_change_record WHERE academic_year_id = ?", [academicYearId]);
    await conn.execute("DELETE FROM score_calculation_batch WHERE academic_year_id = ?", [academicYearId]);
    await conn.execute("DELETE FROM application_record WHERE academic_year_id = ?", [academicYearId]);
    await conn.execute("DELETE FROM audit_batch WHERE academic_year_id = ?", [academicYearId]);
    await conn.execute("DELETE FROM audit_task WHERE academic_year_id = ?", [academicYearId]);
    await conn.execute("UPDATE academic_year SET current_snapshot_id = NULL WHERE id = ?", [academicYearId]);
    await conn.execute("DELETE FROM academic_year_rule_snapshot WHERE academic_year_id = ?", [academicYearId]);
    await conn.execute("DELETE FROM academic_year WHERE id = ?", [academicYearId]);

    await logOperation(conn, {
      operatorId: operator.id,
      operatorName: operator.display_name || operator.username,
      module: "year",
      operationType: "force_delete_academic_year",
      targetType: "academic_year",
      targetId: academicYearId,
      operationDetail: { academic_year_name: year.name, ...usage },
      ipAddress: clientIp(req)
    });
    return {
      id: academicYearId,
      name: year.name,
      force_deleted: true,
      deleted_data: usage,
      deleted_application_ids: applicationRows.map((row) => Number(row.id))
    };
  });

  const applicationRoot = path.resolve(uploadDir, "applications");
  let deletedFileDirectoryCount = 0;
  const fileCleanupErrors = [];
  for (const applicationId of result.deleted_application_ids) {
    const target = path.resolve(applicationRoot, String(applicationId));
    const relative = path.relative(applicationRoot, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
    try {
      await fs.access(target);
      await fs.rm(target, { recursive: true, force: true });
      deletedFileDirectoryCount += 1;
    } catch (error) {
      if (error.code !== "ENOENT") fileCleanupErrors.push({ application_id: applicationId, message: error.message });
    }
  }
  delete result.deleted_application_ids;
  result.deleted_file_directory_count = deletedFileDirectoryCount;
  result.file_cleanup_errors = fileCleanupErrors;
  return result;
}

async function getVersionTree(versionId) {
  // 批量读取节点及其挂载配置，再在内存中组装邻接树，避免逐节点查询数据库。
  const nodes = await query(
    `SELECT *
     FROM rule_node
     WHERE rule_set_version_id = :versionId
     ORDER BY COALESCE(parent_id, 0), sort_order, id`,
    { versionId }
  );
  if (!nodes.length) return [];

  const nodeIds = nodes.map((node) => node.id);
  const placeholders = nodeIds.map((_, index) => `:id${index}`).join(",");
  const params = Object.fromEntries(nodeIds.map((id, index) => [`id${index}`, id]));

  const [calculationConfigs, formFields, materialRequirements, auditRequirements, scopes, groupRules] =
    await Promise.all([
      query(`SELECT * FROM rule_calculation_config WHERE node_id IN (${placeholders}) ORDER BY sort_order, id`, params),
      query(`SELECT * FROM rule_form_field WHERE node_id IN (${placeholders}) ORDER BY sort_order, id`, params),
      query(`SELECT * FROM material_requirement WHERE node_id IN (${placeholders}) ORDER BY id`, params),
      query(`SELECT * FROM audit_requirement WHERE node_id IN (${placeholders}) ORDER BY id`, params),
      query(`SELECT * FROM rule_scope WHERE node_id IN (${placeholders}) ORDER BY id`, params),
      query(`SELECT * FROM group_distribution_rule WHERE node_id IN (${placeholders}) ORDER BY id`, params)
    ]);

  const byNode = (rows) =>
    rows.reduce((map, row) => {
      if (!map.has(row.node_id)) map.set(row.node_id, []);
      map.get(row.node_id).push(row);
      return map;
    }, new Map());

  const calcByNode = byNode(calculationConfigs);
  const fieldByNode = byNode(formFields);
  const materialByNode = byNode(materialRequirements);
  const auditByNode = byNode(auditRequirements);
  const scopeByNode = byNode(scopes);
  const groupByNode = byNode(groupRules);

  const nodeMap = new Map();
  for (const node of nodes) {
    node.children = [];
    node.calculation_configs = calcByNode.get(node.id) || [];
    node.form_fields = fieldByNode.get(node.id) || [];
    node.material_requirements = materialByNode.get(node.id) || [];
    node.audit_requirements = auditByNode.get(node.id) || [];
    node.scopes = scopeByNode.get(node.id) || [];
    node.group_distribution_rules = groupByNode.get(node.id) || [];
    nodeMap.set(node.id, node);
  }

  const roots = [];
  for (const node of nodes) {
    if (node.parent_id && nodeMap.has(node.parent_id)) {
      nodeMap.get(node.parent_id).children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

async function snapshotVersion(versionId) {
  // 将发布时的完整配置保存为 JSON 快照，便于后续复查学生当时看到的规则依据。
  const [version] = await query(
    `SELECT v.*, rs.name AS rule_set_name, rs.college_id
     FROM rule_set_version v
     JOIN rule_set rs ON rs.id = v.rule_set_id
     WHERE v.id = :versionId`,
    { versionId }
  );
  if (!version) {
    const error = new Error("规则版本不存在");
    error.status = 404;
    throw error;
  }
  const tree = await getVersionTree(versionId);
  return {
    version,
    tree,
    generated_at: new Date().toISOString()
  };
}

async function approvedApplicationCount(academicYearId) {
  const [row] = await query(
    `SELECT COUNT(*) AS count
     FROM application_record
     WHERE academic_year_id = :academicYearId AND status = 'approved'`,
    { academicYearId }
  );
  return Number(row?.count || 0);
}

async function bindAcademicYearSnapshot(academicYearId, ruleSetVersionId, operatorId = 1) {
  // 重新绑定会生成新的不可变快照；若学年已有审核通过的申报，
  // 规则依据变化后立即触发全量重算。
  const snapshot = await snapshotVersion(ruleSetVersionId);
  const snapshotJson = JSON.stringify(snapshot);
  const data = await transaction(async (conn) => {
    await conn.execute(
      `UPDATE academic_year_rule_snapshot
       SET status = 'replaced', current_marker = NULL
       WHERE academic_year_id = ? AND current_marker = 1`,
      [academicYearId]
    );
    const [result] = await conn.execute(
      `INSERT INTO academic_year_rule_snapshot
       (academic_year_id, rule_set_version_id, snapshot_json, snapshot_hash, status, current_marker)
       VALUES (?, ?, ?, SHA2(?, 256), 'active', 1)`,
      [academicYearId, ruleSetVersionId, snapshotJson, snapshotJson]
    );
    await conn.execute(
      `UPDATE academic_year SET current_snapshot_id = ? WHERE id = ?`,
      [result.insertId, academicYearId]
    );
    return { id: result.insertId };
  });
  const approvedCount = await approvedApplicationCount(academicYearId);
  data.approved_application_count = approvedCount;
  data.auto_calculation = approvedCount
    ? await runCalculation({
        academicYearId,
        batchType: "auto",
        triggerReason: `rule_snapshot_changed:${data.id}`,
        createdBy: operatorId
      })
    : null;
  return data;
}

async function seedDemo() {
  const demoSuffix = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  return transaction(async (conn) => {
    const [setResult] = await conn.execute(
      `INSERT INTO rule_set (college_id, name, description, status, created_by)
       VALUES (1, '人工智能学院本科生综测规则模板', '用于验证规则配置、树状规则、申报字段和快照绑定。', 'enabled', 1)`
    );
    const ruleSetId = setResult.insertId;

    const [versionResult] = await conn.execute(
      `INSERT INTO rule_set_version
       (rule_set_id, version_no, version_name, status, change_note, published_by, published_at)
       VALUES (?, 'v2026.09-demo', '2025-2026 学年验证版', 'published', '初始化验证规则集', 1, NOW())`,
      [ruleSetId]
    );
    const versionId = versionResult.insertId;

    async function node(parentId, nodeType, code, name, maxScore, aggregationType, isApplyEntry, sortOrder, description = null) {
      const [result] = await conn.execute(
        `INSERT INTO rule_node
         (rule_set_version_id, parent_id, node_type, code, name, max_score, aggregation_type, is_apply_entry, sort_order, status, description)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'enabled', ?)`,
        [versionId, parentId, nodeType, code, name, maxScore, aggregationType, isApplyEntry ? 1 : 0, sortOrder, description]
      );
      return result.insertId;
    }

    const total = await node(null, "aggregate", "total", "综合测评总分", 105, "sum", 0, 1, "思想品德 + 学业成绩 + 学术创新成果 + 学生工作");
    await node(total, "aggregate", "moral", "思想品德", 5, "deduct", 0, 10);
    await node(total, "aggregate", "academic", "学业成绩", 86, "formula", 0, 20);
    const innovation = await node(total, "aggregate", "innovation", "学术创新成果", 7, "cap", 0, 30, "同一子类别取最高，不同子类别可累加");
    const research = await node(innovation, "aggregate", "innovation.research", "科研成果", null, "sum", 0, 10);
    await node(research, "aggregate", "innovation.research.project", "项目成果", null, "max", 0, 10);
    const paper = await node(research, "aggregate", "innovation.research.paper", "论文成果", null, "max", 0, 20);
    const paperItem = await node(paper, "item", "innovation.research.paper.level", "论文成果等级认定", null, "sum", 1, 10, "按期刊/会议等级计分");
    const competition = await node(innovation, "aggregate", "innovation.competition", "竞赛获奖", null, "sum", 0, 20);
    const creative = await node(competition, "aggregate", "innovation.competition.creative", "创意策划类", null, "max", 0, 20);
    const challengeCup = await node(creative, "item", "innovation.competition.creative.challenge_cup", "挑战杯/互联网+竞赛", null, "sum", 1, 10);
    await node(innovation, "aggregate", "innovation.certification", "学科认证", null, "max", 0, 30);

    const work = await node(total, "aggregate", "student_work", "学生工作", 7, "cap", 0, 40);
    const position = await node(work, "aggregate", "student_work.position", "岗位任职", 3, "max", 0, 10, "各岗位类别加分不累计，取最高");
    const classPosition = await node(position, "item", "student_work.position.class", "班级与团支部职务", null, "formula", 1, 10);
    const activity = await node(work, "aggregate", "student_work.activity", "学生活动", 4, "cap", 0, 20);
    const sports = await node(activity, "aggregate", "student_work.activity.sports", "文体比赛类", 2, "cap", 0, 10);
    const sportsItem = await node(sports, "item", "student_work.activity.sports.rank", "文体比赛获奖", null, "weight", 1, 10, "运动会项目可按A/B/C级权重修正");
    const practice = await node(activity, "aggregate", "student_work.activity.practice", "实践活动", 1.5, "cap", 0, 20);
    const practiceItem = await node(practice, "item", "student_work.activity.practice.social", "寒暑期社会实践", null, "level", 1, 10);
    await node(activity, "aggregate", "student_work.activity.party_class", "党团班活动", 2, "cap", 0, 30);
    await node(work, "aggregate", "student_work.penalty", "违规处罚", null, "deduct", 0, 30);

    await conn.execute(
      `INSERT INTO rule_calculation_config (node_id, config_type, formula_code, config_json, rounding_rule)
       VALUES
       (?, 'level', NULL, ?, 'none'),
       (?, 'level', NULL, ?, 'none'),
       (?, 'formula', 'POSITION_SCORE_BY_WEIGHT', ?, 'round'),
       (?, 'weight', 'BASE_SCORE_TIMES_WEIGHT', ?, 'round'),
       (?, 'level', NULL, ?, 'none')`,
      [
        paperItem,
        JSON.stringify({ levels: [{ name: "A+类", score: 7 }, { name: "A类", score: 5 }, { name: "B类", score: 2 }, { name: "C类", score: 0.8 }] }),
        challengeCup,
        JSON.stringify({ levels: [{ name: "国家级金奖/一等奖", score: 5 }, { name: "国家级银奖/二等奖", score: 3.5 }, { name: "省市级一等奖", score: 2 }] }),
        classPosition,
        JSON.stringify({ formula: "base_score * evaluation_weight", base_scores: [{ name: "班长/团支书/学习委员", score: 2 }, { name: "体育委员/文艺委员/其他班委", score: 1 }] }),
        sportsItem,
        JSON.stringify({ levels: [{ name: "校级一档", score: 2 }, { name: "校级二档", score: 1 }, { name: "校级三档", score: 0.5 }, { name: "校级四档", score: 0.3 }, { name: "校级五档", score: 0.1 }], weights: [{ name: "A类项目", weight: 1 }, { name: "B类项目", weight: 0.8 }, { name: "C类项目", weight: 0.6 }] }),
        practiceItem,
        JSON.stringify({ levels: [{ name: "特等-主持", score: 1 }, { name: "特等-参与", score: 0.5 }, { name: "一等-主持", score: 0.9 }, { name: "二等-参与", score: 0.15 }] })
      ]
    );

    await conn.execute(
      `INSERT INTO rule_form_field (node_id, field_key, field_label, field_type, required, options_json, validation_json, sort_order)
       VALUES
       (?, 'paper_level', '论文等级', 'select', 1, ?, NULL, 1),
       (?, 'paper_title', '论文题目', 'text', 1, NULL, NULL, 2),
       (?, 'competition_level', '获奖等级', 'select', 1, ?, NULL, 1),
       (?, 'member_role', '本人角色', 'select', 1, ?, NULL, 2),
       (?, 'position_name', '职务名称', 'select', 1, ?, NULL, 1),
       (?, 'evaluation_weight', '评议权重', 'number', 1, NULL, ?, 2),
       (?, 'award_level', '比赛分档', 'select', 1, ?, NULL, 1),
       (?, 'event_weight', '项目难度', 'select', 0, ?, NULL, 2),
       (?, 'practice_level', '结项等级与角色', 'select', 1, ?, NULL, 1)`,
      [
        paperItem,
        JSON.stringify(["A+类", "A类", "B类", "C类"]),
        paperItem,
        challengeCup,
        JSON.stringify(["国家级金奖/一等奖", "国家级银奖/二等奖", "省市级一等奖"]),
        challengeCup,
        JSON.stringify(["负责人", "成员前50%", "成员后50%"]),
        classPosition,
        JSON.stringify(["班长/团支书/学习委员", "体育委员/文艺委员/其他班委"]),
        classPosition,
        JSON.stringify({ min: 0, max: 1, step: 0.01 }),
        sportsItem,
        JSON.stringify(["校级一档", "校级二档", "校级三档", "校级四档", "校级五档"]),
        sportsItem,
        JSON.stringify(["A类项目", "B类项目", "C类项目"]),
        practiceItem,
        JSON.stringify(["特等-主持", "特等-参与", "一等-主持", "二等-参与"])
      ]
    );

    await conn.execute(
      `INSERT INTO material_requirement (node_id, material_name, required, description, file_type_limit, max_file_count)
       VALUES
       (?, '论文检索页或录用证明', 1, '需体现作者、单位、会议/期刊等级等信息。', 'pdf,jpg,png', 3),
       (?, '获奖证书或官方公示截图', 1, '团队项目需提供成员排名证明。', 'pdf,jpg,png', 5),
       (?, '任职证明或评议结果', 1, '需包含任职周期和评议等级/权重。', 'pdf,jpg,png', 2),
       (?, '比赛证明材料', 1, '需包含比赛名称、名次和参赛名单。', 'pdf,jpg,png', 3),
       (?, '实践结项证明', 1, '需包含结项等级、本人角色和团队成员信息。', 'pdf,jpg,png', 3)`,
      [paperItem, challengeCup, classPosition, sportsItem, practiceItem]
    );

    await conn.execute(
      `INSERT INTO audit_requirement (node_id, audit_role, audit_instruction, reject_reason_template, need_second_audit)
       VALUES
       (?, 'college_admin', '核对论文等级目录、作者顺序和学院署名。', ?, 1),
       (?, 'class_committee', '核对获奖等级、团队成员排名和证书真实性。', ?, 1),
       (?, 'class_committee', '核对任职时间是否满一年，评议权重是否有效。', ?, 0),
       (?, 'class_committee', '核对参赛名单、比赛分档和运动会项目权重。', ?, 0)`,
      [
        paperItem,
        JSON.stringify(["论文等级不在目录内", "作者顺序不符合规则", "证明材料不完整"]),
        challengeCup,
        JSON.stringify(["获奖等级无法确认", "团队排名证明缺失", "非主赛道未注明"]),
        classPosition,
        JSON.stringify(["任职未满要求", "评议权重缺失"]),
        sportsItem,
        JSON.stringify(["参赛名单缺失", "比赛分档不符合规则"])
      ]
    );

    await conn.execute(
      `INSERT INTO group_distribution_rule (node_id, distribution_type, config_json)
       VALUES (?, 'first_second_half', ?)`,
      [challengeCup, JSON.stringify({ leader_score_ratio: 1, first_half_ratio: 0.6, second_half_ratio: 0.4, basis: "获奖证书排名" })]
    );

    await conn.execute(
      `INSERT INTO rule_scope (node_id, scope_type, scope_value, include_or_exclude)
       VALUES (?, 'student_type', 'normal', 'include')`,
      [sportsItem]
    );

    const [yearResult] = await conn.execute(
      `INSERT INTO academic_year
       (name, evaluation_start_date, evaluation_end_date, apply_start_time, apply_end_time, audit_start_time, audit_end_time, status)
       VALUES (?, '2025-09-01', '2026-08-31', '2026-09-01 00:00:00', '2026-09-20 23:59:59',
       '2026-09-21 00:00:00', '2026-10-10 23:59:59', 'configuring')`,
      [`2025-2026学年度验证-${demoSuffix}`]
    );

    return { ruleSetId, versionId, academicYearId: yearResult.insertId };
  });
}

async function handleApi(req, res) {
  // 请求先交给各业务模块路由处理；所有模块都未处理时才返回 404。
  const { parts } = parseRoute(req);
  const method = req.method || "GET";
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (method === "GET" && parts.join("/") === "api/health") {
    const rows = await query("SELECT 1 AS ok");
    const [tableCount] = await query("SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = DATABASE()");
    return ok(res, { database: rows[0].ok === 1, table_count: tableCount.count });
  }

  const handledByAuditCalculation = await handleAuditCalculationApi(req, res, { parts, method, url, ok, fail, readJson });
  if (handledByAuditCalculation !== false) return;

  const handledByApplicationSubmission = await handleApplicationSubmissionApi(req, res, { parts, method, url, ok, fail, readJson });
  if (handledByApplicationSubmission !== false) return;

  const handledByResultManagement = await handleResultManagementApi(req, res, { parts, method, url, ok, fail, readJson });
  if (handledByResultManagement !== false) return;

  const handledBySystemManagement = await handleSystemManagementApi(req, res, { parts, method, url, ok, fail, readJson });
  if (handledBySystemManagement !== false) return;

  if (method === "POST" && parts.join("/") === "api/dev/seed") {
    const data = await seedDefaultRuleSet();
    const snapshot = await bindAcademicYearSnapshot(data.academicYearId, data.versionId, 1);
    data.snapshotId = snapshot.id;
    data.auto_calculation = snapshot.auto_calculation;
    return ok(res, data, "默认规则集已创建");
  }

  if (method === "POST" && parts.join("/") === "api/dev/seed-demo") {
    const data = await seedDemo();
    return ok(res, data, "示例规则集已创建");
  }

  if (method === "GET" && parts.join("/") === "api/rule-sets") {
    const rows = await query(
      `SELECT rs.*,
        COUNT(v.id) AS version_count,
        MAX(v.published_at) AS last_published_at
       FROM rule_set rs
       LEFT JOIN rule_set_version v ON v.rule_set_id = rs.id
       GROUP BY rs.id
       ORDER BY rs.updated_at DESC, rs.id DESC`
    );
    return ok(res, rows);
  }

  if (method === "POST" && parts.join("/") === "api/rule-sets") {
    const body = await readJson(req);
    const result = await query(
      `INSERT INTO rule_set (college_id, name, description, status, created_by)
       VALUES (:collegeId, :name, :description, :status, :createdBy)`,
      {
        collegeId: body.college_id || body.collegeId || 1,
        name: body.name,
        description: body.description || null,
        status: body.status || "enabled",
        createdBy: body.created_by || body.createdBy || 1
      }
    );
    return ok(res, { id: result.insertId }, "规则集已创建");
  }

  if (method === "DELETE" && parts[0] === "api" && parts[1] === "rule-sets" && parts.length === 3) {
    const data = await deleteRuleSet(Number(parts[2]), req);
    return ok(res, data, data.deleted ? "规则集已删除" : "规则集已归档");
  }

  if (method === "GET" && parts[0] === "api" && parts[1] === "rule-sets" && parts[3] === "versions") {
    const ruleSetId = Number(parts[2]);
    const rows = await query(
      `SELECT * FROM rule_set_version WHERE rule_set_id = :ruleSetId ORDER BY created_at DESC, id DESC`,
      { ruleSetId }
    );
    return ok(res, rows);
  }

  if (method === "POST" && parts[0] === "api" && parts[1] === "rule-sets" && parts[3] === "versions") {
    const ruleSetId = Number(parts[2]);
    const body = await readJson(req);
    const result = await query(
      `INSERT INTO rule_set_version (rule_set_id, version_no, version_name, status, change_note)
       VALUES (:ruleSetId, :versionNo, :versionName, 'draft', :changeNote)`,
      {
        ruleSetId,
        versionNo: body.version_no || body.versionNo,
        versionName: body.version_name || body.versionName || null,
        changeNote: body.change_note || body.changeNote || null
      }
    );
    return ok(res, { id: result.insertId }, "规则版本已创建");
  }

  if (method === "POST" && parts[0] === "api" && parts[1] === "rule-versions" && parts[3] === "publish") {
    const versionId = Number(parts[2]);
    await query(
      `UPDATE rule_set_version
       SET status = 'published', published_by = :publishedBy, published_at = NOW()
       WHERE id = :versionId`,
      { versionId, publishedBy: 1 }
    );
    return ok(res, { id: versionId }, "规则版本已发布");
  }

  if (method === "GET" && parts[0] === "api" && parts[1] === "rule-versions" && parts[3] === "tree") {
    const versionId = Number(parts[2]);
    const tree = await getVersionTree(versionId);
    return ok(res, tree);
  }

  if (method === "POST" && parts[0] === "api" && parts[1] === "rule-versions" && parts[3] === "nodes") {
    const versionId = Number(parts[2]);
    const body = await readJson(req);
    const parentId = normalizeParentId(body.parent_id ?? body.parentId);
    const isApplyEntry = toBool(body.is_apply_entry ?? body.isApplyEntry);
    const nodeType = await validateRuleNodeStructure({
      versionId,
      parentId,
      nodeType: body.node_type || body.nodeType,
      isApplyEntry
    });
    const result = await query(
      `INSERT INTO rule_node
       (rule_set_version_id, parent_id, node_type, code, name, max_score, aggregation_type, is_apply_entry, sort_order, status, description)
       VALUES (:versionId, :parentId, :nodeType, :code, :name, :maxScore, :aggregationType, :isApplyEntry, :sortOrder, 'enabled', :description)`,
      {
        versionId,
        parentId,
        nodeType,
        code: body.code,
        name: body.name,
        maxScore: toNullableDecimal(body.max_score ?? body.maxScore),
        aggregationType: body.aggregation_type || body.aggregationType || null,
        isApplyEntry: isApplyEntry ? 1 : 0,
        sortOrder: Number(body.sort_order || body.sortOrder || 0),
        description: body.description || null
      }
    );
    return ok(res, { id: result.insertId }, "规则节点已创建");
  }

  if (method === "PUT" && parts[0] === "api" && parts[1] === "rule-nodes" && parts.length === 3) {
    const nodeId = Number(parts[2]);
    const body = await readJson(req);
    const [existingNode] = await query(
      `SELECT id, rule_set_version_id FROM rule_node WHERE id = :nodeId`,
      { nodeId }
    );
    if (!existingNode) throw httpError(404, "规则节点不存在");
    const parentId = normalizeParentId(body.parent_id ?? body.parentId);
    const isApplyEntry = toBool(body.is_apply_entry ?? body.isApplyEntry);
    const nodeType = await validateRuleNodeStructure({
      versionId: existingNode.rule_set_version_id,
      nodeId,
      parentId,
      nodeType: body.node_type || body.nodeType,
      isApplyEntry
    });
    await query(
      `UPDATE rule_node
       SET parent_id = :parentId,
           node_type = :nodeType,
           code = :code,
           name = :name,
           max_score = :maxScore,
           aggregation_type = :aggregationType,
           is_apply_entry = :isApplyEntry,
           sort_order = :sortOrder,
           status = :status,
           description = :description
       WHERE id = :nodeId`,
      {
        nodeId,
        parentId,
        nodeType,
        code: body.code,
        name: body.name,
        maxScore: toNullableDecimal(body.max_score ?? body.maxScore),
        aggregationType: body.aggregation_type || body.aggregationType || null,
        isApplyEntry: isApplyEntry ? 1 : 0,
        sortOrder: Number(body.sort_order || body.sortOrder || 0),
        status: body.status || "enabled",
        description: body.description || null
      }
    );
    return ok(res, { id: nodeId }, "规则节点已更新");
  }

  if (method === "DELETE" && parts[0] === "api" && parts[1] === "rule-nodes" && parts.length === 3) {
    const nodeId = Number(parts[2]);
    const data = await deleteRuleNode(nodeId, req);
    data.auto_calculations = [];
    for (const academicYearId of data.affected_academic_year_ids) {
      const [approved] = await query(
        `SELECT COUNT(*) AS count FROM application_record
         WHERE academic_year_id = :academicYearId AND status = 'approved'`,
        { academicYearId }
      );
      if (Number(approved.count) > 0) {
        data.auto_calculations.push(
          await runCalculation({
            academicYearId,
            batchType: "rule_change",
            triggerReason: "rule_node_deleted",
            createdBy: 1
          })
        );
      }
    }
    return ok(res, data, "规则节点及其下级已删除");
  }

  if (method === "POST" && parts[0] === "api" && parts[1] === "rule-nodes" && parts[3] === "calculation-configs") {
    const nodeId = Number(parts[2]);
    const body = await readJson(req);
    const result = await query(
      `INSERT INTO rule_calculation_config (node_id, config_type, formula_code, config_json, rounding_rule, sort_order)
       VALUES (:nodeId, :configType, :formulaCode, :configJson, :roundingRule, :sortOrder)`,
      {
        nodeId,
        configType: body.config_type || body.configType,
        formulaCode: body.formula_code || body.formulaCode || null,
        configJson: jsonParam(body.config_json ?? body.configJson ?? {}),
        roundingRule: body.rounding_rule || body.roundingRule || null,
        sortOrder: Number(body.sort_order || body.sortOrder || 0)
      }
    );
    return ok(res, { id: result.insertId }, "计分配置已保存");
  }

  if (method === "POST" && parts[0] === "api" && parts[1] === "rule-nodes" && parts[3] === "form-fields") {
    const nodeId = Number(parts[2]);
    const body = await readJson(req);
    const result = await query(
      `INSERT INTO rule_form_field
       (node_id, field_key, field_label, field_type, required, options_json, validation_json, sort_order)
       VALUES (:nodeId, :fieldKey, :fieldLabel, :fieldType, :required, :optionsJson, :validationJson, :sortOrder)`,
      {
        nodeId,
        fieldKey: body.field_key || body.fieldKey,
        fieldLabel: body.field_label || body.fieldLabel,
        fieldType: body.field_type || body.fieldType,
        required: toBool(body.required) ? 1 : 0,
        optionsJson: jsonParam(body.options_json ?? body.optionsJson ?? null),
        validationJson: jsonParam(body.validation_json ?? body.validationJson ?? null),
        sortOrder: Number(body.sort_order || body.sortOrder || 0)
      }
    );
    return ok(res, { id: result.insertId }, "申报字段已添加");
  }

  if (method === "POST" && parts[0] === "api" && parts[1] === "rule-nodes" && parts[3] === "materials") {
    const nodeId = Number(parts[2]);
    const body = await readJson(req);
    const result = await query(
      `INSERT INTO material_requirement (node_id, material_name, required, description, file_type_limit, max_file_count)
       VALUES (:nodeId, :materialName, :required, :description, :fileTypeLimit, :maxFileCount)`,
      {
        nodeId,
        materialName: body.material_name || body.materialName,
        required: toBool(body.required ?? true) ? 1 : 0,
        description: body.description || null,
        fileTypeLimit: body.file_type_limit || body.fileTypeLimit || null,
        maxFileCount: Number(body.max_file_count || body.maxFileCount || 1)
      }
    );
    return ok(res, { id: result.insertId }, "材料要求已添加");
  }

  if (method === "POST" && parts[0] === "api" && parts[1] === "rule-nodes" && parts[3] === "audit-requirements") {
    const nodeId = Number(parts[2]);
    const body = await readJson(req);
    const result = await query(
      `INSERT INTO audit_requirement (node_id, audit_role, audit_instruction, reject_reason_template, need_second_audit)
       VALUES (:nodeId, :auditRole, :auditInstruction, :rejectReasonTemplate, :needSecondAudit)`,
      {
        nodeId,
        auditRole: body.audit_role || body.auditRole,
        auditInstruction: body.audit_instruction || body.auditInstruction || null,
        rejectReasonTemplate: jsonParam(body.reject_reason_template ?? body.rejectReasonTemplate ?? null),
        needSecondAudit: toBool(body.need_second_audit ?? body.needSecondAudit) ? 1 : 0
      }
    );
    return ok(res, { id: result.insertId }, "审核要求已添加");
  }

  if (method === "POST" && parts[0] === "api" && parts[1] === "rule-nodes" && parts[3] === "scopes") {
    const nodeId = Number(parts[2]);
    const body = await readJson(req);
    const result = await query(
      `INSERT INTO rule_scope (node_id, scope_type, scope_value, include_or_exclude)
       VALUES (:nodeId, :scopeType, :scopeValue, :includeOrExclude)`,
      {
        nodeId,
        scopeType: body.scope_type || body.scopeType,
        scopeValue: body.scope_value || body.scopeValue,
        includeOrExclude: body.include_or_exclude || body.includeOrExclude || "include"
      }
    );
    return ok(res, { id: result.insertId }, "适用范围已添加");
  }

  if (method === "POST" && parts[0] === "api" && parts[1] === "rule-nodes" && parts[3] === "group-rules") {
    const nodeId = Number(parts[2]);
    const body = await readJson(req);
    const result = await query(
      `INSERT INTO group_distribution_rule (node_id, distribution_type, config_json)
       VALUES (:nodeId, :distributionType, :configJson)`,
      {
        nodeId,
        distributionType: body.distribution_type || body.distributionType,
        configJson: jsonParam(body.config_json ?? body.configJson ?? {})
      }
    );
    return ok(res, { id: result.insertId }, "团体分配规则已添加");
  }

  if (method === "GET" && parts.join("/") === "api/academic-years") {
    const rows = await query(
      `SELECT y.*, s.rule_set_version_id
       FROM academic_year y
       LEFT JOIN academic_year_rule_snapshot s ON s.id = y.current_snapshot_id
       ORDER BY y.created_at DESC, y.id DESC`
    );
    return ok(res, rows);
  }

  if (method === "POST" && parts.join("/") === "api/academic-years") {
    const body = await readJson(req);
    const result = await query(
      `INSERT INTO academic_year
       (name, evaluation_start_date, evaluation_end_date, apply_start_time, apply_end_time, audit_start_time, audit_end_time, publicity_start_time, publicity_end_time, status)
       VALUES (:name, :evaluationStartDate, :evaluationEndDate, :applyStartTime, :applyEndTime, :auditStartTime, :auditEndTime, :publicityStartTime, :publicityEndTime, :status)`,
      {
        name: body.name,
        evaluationStartDate: body.evaluation_start_date || body.evaluationStartDate,
        evaluationEndDate: body.evaluation_end_date || body.evaluationEndDate,
        applyStartTime: body.apply_start_time || body.applyStartTime || null,
        applyEndTime: body.apply_end_time || body.applyEndTime || null,
        auditStartTime: body.audit_start_time || body.auditStartTime || null,
        auditEndTime: body.audit_end_time || body.auditEndTime || null,
        publicityStartTime: body.publicity_start_time || body.publicityStartTime || null,
        publicityEndTime: body.publicity_end_time || body.publicityEndTime || null,
        status: body.status || "configuring"
      }
    );
    return ok(res, { id: result.insertId }, "学年已创建");
  }

  if (method === "DELETE" && parts[0] === "api" && parts[1] === "academic-years" && parts.length === 3) {
    const academicYearId = Number(parts[2]);
    const force = url.searchParams.get("force") === "true";
    const data = force
      ? await forceDeleteAcademicYear(academicYearId, url.searchParams.get("confirmName"), req)
      : await deleteAcademicYear(academicYearId, req);
    if (force) return ok(res, data, "学年及其全部业务数据已彻底删除");
    return ok(res, data, data.deleted ? "学年已删除" : "学年已归档");
  }

  if (method === "POST" && parts[0] === "api" && parts[1] === "academic-years" && parts[3] === "bind-snapshot") {
    const academicYearId = Number(parts[2]);
    const body = await readJson(req);
    const ruleSetVersionId = Number(body.rule_set_version_id || body.ruleSetVersionId);
    const data = await bindAcademicYearSnapshot(academicYearId, ruleSetVersionId, body.operator_id || body.operatorId || 1);
    return ok(res, data, "学年规则快照已绑定");
  }

  return fail(res, 404, "接口不存在");
}

async function serveStatic(req, res) {
  // 上传材料与前端静态资源使用不同根目录；读取前校验解析后的路径，
  // 防止通过路径穿越访问项目目录之外的文件。
  const { url } = parseRoute(req);
  let filePath = decodeURIComponent(url.pathname);
  if (filePath.startsWith("/uploads/")) {
    const uploadRelativePath = filePath.replace(/^\/uploads\/?/, "");
    const resolvedUpload = path.normalize(path.join(uploadDir, uploadRelativePath));
    const relative = path.relative(uploadDir, resolvedUpload);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return fail(res, 403, "禁止访问");
    }
    try {
      const content = await fs.readFile(resolvedUpload);
      const ext = path.extname(resolvedUpload).toLowerCase();
      const types = {
        ".pdf": "application/pdf",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".gif": "image/gif",
        ".txt": "text/plain; charset=utf-8"
      };
      res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
      res.end(content);
      return;
    } catch {
      return fail(res, 404, "文件不存在");
    }
  }
  if (filePath === "/") filePath = "/index.html";
  const resolved = path.normalize(path.join(publicDir, filePath));
  if (!resolved.startsWith(publicDir)) {
    return fail(res, 403, "禁止访问");
  }
  try {
    const content = await fs.readFile(resolved);
    const ext = path.extname(resolved);
    const types = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8"
    };
    res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
    res.end(content);
  } catch {
    const fallback = await fs.readFile(path.join(publicDir, "index.html"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(fallback);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const { parts } = parseRoute(req);
    if (parts[0] === "api") {
      await handleApi(req, res);
      return;
    }
    await serveStatic(req, res);
  } catch (error) {
    const status = error.status || 500;
    console.error(error);
    fail(res, status, error.message || "服务异常", error.details || (process.env.NODE_ENV === "development" ? error.stack : undefined));
  }
});

server.listen(port, host, async () => {
  try {
    const [tableCount] = await query("SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = DATABASE()");
    console.log(`Rule config demo is running at http://${host}:${port}`);
    console.log(`Local access: http://localhost:${port}`);
    console.log(`Connected to MySQL with ${tableCount.count} tables.`);
  } catch (error) {
    console.error("Server started, but database connection failed:", error.message);
  }
});

process.on("SIGINT", async () => {
  await pool.end();
  process.exit(0);
});
