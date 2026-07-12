$ErrorActionPreference = "Stop"

. "$PSScriptRoot\common.ps1"

@'
import mysql from "mysql2/promise";

const base = "http://127.0.0.1:5173";
const db = await mysql.createConnection({
  host: "127.0.0.1",
  port: 3307,
  user: "zongce",
  password: "zongce123",
  database: "bnuai_zongce"
});

async function request(path, options = {}) {
  const response = await fetch(base + path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const body = await response.json();
  return { response, body };
}

async function api(path, options = {}) {
  const { response, body } = await request(path, options);
  if (!response.ok || body.code >= 400) throw new Error(body.message || JSON.stringify(body));
  return body.data;
}

let superAdminId = null;
let ruleSetId = null;
try {
  const suffix = Date.now();
  const admin = await api("/api/admin/users", {
    method: "POST",
    body: JSON.stringify({
      username: `force_delete_admin_${suffix}`,
      displayName: "Force Delete Verification",
      password: "verify-password",
      role: "super_admin",
      status: "active"
    })
  });
  superAdminId = admin.id;

  const seeded = await api("/api/dev/seed", { method: "POST", body: "{}" });
  ruleSetId = seeded.ruleSetId;
  const auditSeed = await api("/api/dev/seed-audit-calculation", { method: "POST", body: "{}" });

  let calculation = null;
  for (const applicationId of auditSeed.applicationIds) {
    const approval = await api(`/api/audit/applications/${applicationId}/actions`, {
      method: "POST",
      body: JSON.stringify({ action: "approve", auditRole: "college_admin", comment: "force delete verification" })
    });
    calculation = approval.auto_calculation || calculation;
  }
  if (!calculation) throw new Error("Approval did not trigger calculation");

  await api("/api/results/publicity/start", {
    method: "POST",
    body: JSON.stringify({
      academicYearId: auditSeed.academicYearId,
      batchId: calculation.batchId,
      initiatorRole: "college_admin"
    })
  });

  const [[referencedNode]] = await db.query(
    "SELECT rule_node_id FROM application_record WHERE id = ?",
    [auditSeed.applicationIds[0]]
  );
  const referencedNodeDelete = await request(`/api/rule-nodes/${referencedNode.rule_node_id}`, { method: "DELETE" });
  if (referencedNodeDelete.response.status !== 409) {
    throw new Error(`Expected 409 when deleting a referenced node, got ${referencedNodeDelete.response.status}`);
  }

  const yearsBefore = await api("/api/academic-years");
  const year = yearsBefore.find((row) => Number(row.id) === Number(auditSeed.academicYearId));
  if (!year) throw new Error("Seeded academic year was not found");

  const denied = await request(
    `/api/academic-years/${year.id}?force=true&confirmName=${encodeURIComponent(year.name)}`,
    { method: "DELETE" }
  );
  if (denied.response.status !== 403) throw new Error(`Expected 403 without super admin, got ${denied.response.status}`);

  const deleted = await api(
    `/api/academic-years/${year.id}?force=true&confirmName=${encodeURIComponent(year.name)}`,
    { method: "DELETE", headers: { "X-Operator-Id": String(superAdminId) } }
  );

  const [[remaining]] = await db.query(
    `SELECT
       (SELECT COUNT(*) FROM academic_year WHERE id = ?) AS year_count,
       (SELECT COUNT(*) FROM academic_year_rule_snapshot WHERE academic_year_id = ?) AS snapshot_count,
       (SELECT COUNT(*) FROM application_record WHERE academic_year_id = ?) AS application_count,
       (SELECT COUNT(*) FROM score_calculation_batch WHERE academic_year_id = ?) AS calculation_count,
       (SELECT COUNT(*) FROM publicity_batch WHERE academic_year_id = ?) AS publicity_count,
       (SELECT COUNT(*) FROM audit_task WHERE academic_year_id = ?) AS audit_task_count`,
    [year.id, year.id, year.id, year.id, year.id, year.id]
  );
  if (Object.values(remaining).some((value) => Number(value) !== 0)) {
    throw new Error(`Academic year data remains: ${JSON.stringify(remaining)}`);
  }

  const ruleSetDeletion = await api(`/api/rule-sets/${ruleSetId}`, { method: "DELETE" });
  ruleSetId = null;
  if (!ruleSetDeletion.deleted) throw new Error("Rule set could not be deleted after year cleanup");

  console.log(JSON.stringify({
    passed: true,
    referencedNodeDeletionBlocked: referencedNodeDelete.response.status === 409,
    deniedWithoutSuperAdmin: denied.response.status === 403,
    forceDeleted: deleted.force_deleted,
    deletedData: deleted.deleted_data,
    remaining
  }, null, 2));
} finally {
  if (superAdminId) await db.execute("DELETE FROM system_user WHERE id = ?", [superAdminId]);
  await db.end();
}
'@ | & $NodeExe --input-type=module -
