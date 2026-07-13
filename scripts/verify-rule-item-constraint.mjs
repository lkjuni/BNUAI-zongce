const base = process.env.BASE_URL || "http://127.0.0.1:5173";

async function request(path, options = {}) {
  const response = await fetch(base + path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const body = await response.json();
  return { response, body };
}

async function api(path, options = {}) {
  const { response, body } = await request(path, options);
  if (!response.ok || body.code >= 400) throw new Error(`${body.message}: ${JSON.stringify(body.details || {})}`);
  return body.data;
}

function flatten(nodes, result = []) {
  for (const node of nodes) {
    result.push(node);
    flatten(node.children || [], result);
  }
  return result;
}

function parseOptions(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  return JSON.parse(value);
}

function fieldValue(field) {
  if (field.field_type === "select") return parseOptions(field.options_json)[0];
  if (field.field_type === "number") {
    const validation = typeof field.validation_json === "object" ? field.validation_json : JSON.parse(field.validation_json || "{}");
    return validation.min ?? 1;
  }
  return "自动验证内容";
}

const login = await api("/api/auth/login", {
  method: "POST",
  body: JSON.stringify({ username: "student001", password: "123456", role: "student" })
});
const headers = { Authorization: `Bearer ${login.token}` };
const ruleSets = await api("/api/rule-sets", { headers });
if (ruleSets.length !== 1) throw new Error(`预期 1 个规则集，实际 ${ruleSets.length}`);
const versions = await api(`/api/rule-sets/${ruleSets[0].id}/versions`, { headers });
const tree = await api(`/api/rule-versions/${versions[0].id}/tree`, { headers });
const nodes = flatten(tree);
const items = nodes.filter((node) => node.node_type === "item");
const aggregates = nodes.filter((node) => node.node_type === "aggregate");

const itemErrors = items.flatMap((node) => {
  const errors = [];
  if (node.max_score !== null) errors.push(`${node.code}: item 设置了 max_score`);
  if (node.aggregation_type !== null) errors.push(`${node.code}: item 设置了 aggregation_type`);
  if (Number(node.allow_repeat) !== 0) errors.push(`${node.code}: item 允许重复申报`);
  if (!node.is_apply_entry) errors.push(`${node.code}: item 不是申报入口`);
  if ((node.children || []).length) errors.push(`${node.code}: item 含子节点`);
  if (!(node.calculation_configs || []).length) errors.push(`${node.code}: item 缺少计分配置`);
  return errors;
});
const aggregateErrors = aggregates.flatMap((node) => {
  const errors = [];
  if (node.is_apply_entry) errors.push(`${node.code}: aggregate 是申报入口`);
  if (!node.aggregation_type) errors.push(`${node.code}: aggregate 缺少汇总方式`);
  if ((node.children || []).length === 1) errors.push(`${node.code}: aggregate 只有一个子节点`);
  return errors;
});
if (itemErrors.length || aggregateErrors.length) throw new Error([...itemErrors, ...aggregateErrors].join("\n"));

const years = await api("/api/academic-years", { headers });
const year = years.find((row) => row.current_snapshot_id);
const entriesPayload = await api(`/api/apply/entries?academicYearId=${year.id}`, { headers });
const entry = entriesPayload.entries.find((row) => row.code === "innovation.research.project") || entriesPayload.entries[0];
const fieldValues = Object.fromEntries(entry.form_fields.filter((field) => field.required).map((field) => [field.field_key, fieldValue(field)]));
const payload = {
  academicYearId: year.id,
  ruleNodeId: entry.id,
  studentId: login.user.relatedStudentId,
  title: "规则项唯一性验证",
  fieldValues
};
const application = await api("/api/apply/applications", { method: "POST", headers, body: JSON.stringify(payload) });
const duplicate = await request("/api/apply/applications", { method: "POST", headers, body: JSON.stringify(payload) });
if (duplicate.response.status !== 409) throw new Error(`重复申报应返回 409，实际 ${duplicate.response.status}`);

const material = entry.material_requirements[0];
const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nNwAAAAASUVORK5CYII=";
const attached = await api(`/api/apply/applications/${application.id}/attachments`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    studentId: login.user.relatedStudentId,
    materialRequirementId: material.id,
    fileName: "proof.png",
    mimeType: "image/png",
    contentBase64: pngBase64
  })
});

console.log(JSON.stringify({
  passed: true,
  aggregateCount: aggregates.length,
  itemCount: items.length,
  redundantAggregateCount: aggregates.filter((node) => (node.children || []).length === 1).length,
  duplicateStatus: duplicate.response.status,
  applicationId: application.id,
  attachmentUrl: attached.fileUrl
}, null, 2));
