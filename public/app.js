// 使用单一前端状态保存当前选择，确保用户在规则、申报、审核、核算和结果页切换时状态一致。
const state = {
  authToken: localStorage.getItem("zongce_auth_token") || "",
  currentUser: null,
  ruleSets: [],
  versions: [],
  years: [],
  selectedRuleSetId: null,
  selectedVersionId: null,
  tree: [],
  selectedNode: null,
  activeTab: "rules",
  applyEntries: [],
  selectedApplyEntry: null,
  applyApplications: [],
  selectedApplyApplication: null,
  selectedApplyYearId: null,
  applyStudentId: "2026001",
  auditApplications: [],
  selectedAuditApplication: null,
  calcBatches: [],
  selectedCalcBatchId: null,
  calcResults: [],
  calcDetail: null,
  resultData: null,
  classStats: null,
  publicityBatches: [],
  publicityStatus: null,
  students: [],
  selectedStudent: null,
  users: [],
  selectedUser: null,
  operationLogs: [],
  systemTab: "students",
  importEntries: [],
  importHistory: []
};

const $ = (selector) => document.querySelector(selector);

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: {
      "Content-Type": "application/json",
      ...(state.authToken ? { Authorization: `Bearer ${state.authToken}` } : {}),
      ...(options.headers || {})
    },
    ...options
  });
  const body = await res.json();
  if (!res.ok || body.code >= 400) {
    throw new Error(body.message || "请求失败");
  }
  return body.data;
}

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2200);
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function parseJsonInput(value, fallback = null) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return fallback;
  return JSON.parse(trimmed);
}

function parseMaybeJson(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function optionValues(options) {
  const parsed = parseMaybeJson(options, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.map((item) => {
    if (item && typeof item === "object") return item.value ?? item.name ?? item.label;
    return item;
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function ruleNodeTypeLabel(node) {
  if (node.node_type === "item") return "规则项";
  return node.parent_id ? "汇总节点" : "根汇总节点";
}

function statusLabel(status) {
  return {
    draft: "草稿",
    submitted: "待审核",
    returned: "已退回",
    approved: "已通过",
    rejected: "已驳回",
    withdrawn: "已撤回"
  }[status] || status || "-";
}

function roleLabel(role) {
  return {
    student: "学生",
    class_committee: "学委",
    college_admin: "学院管理员",
    super_admin: "最高管理员"
  }[role] || role || "未登录";
}

function allowedTabs(role) {
  if (role === "student") return ["apply", "result"];
  if (role === "class_committee") return ["audit", "import", "result"];
  return ["rules", "node", "config", "year", "apply", "audit", "import", "calc", "result", "system"];
}

function applyRoleWorkspace(user) {
  state.currentUser = user;
  const tabs = allowedTabs(user.role);
  document.body.classList.remove("auth-pending");
  document.body.classList.add("auth-ready");
  document.body.classList.toggle("role-basic", ["student", "class_committee"].includes(user.role));
  $("#currentRoleLabel").textContent = roleLabel(user.role);
  $("#currentUserName").textContent = user.displayName || user.username;
  $("#seedAuditBtn").hidden = user.role === "class_committee";
  $("#startClassPublicityBtn").hidden = user.role !== "class_committee";
  $("#startCollegePublicityBtn").hidden = !["college_admin", "super_admin"].includes(user.role);
  $("#endPublicityBtn").hidden = user.role === "student";
  $("#importTitle").textContent = user.role === "class_committee" ? "学委统一上传" : "学院统一上传";
  if (["student", "class_committee"].includes(user.role)) {
    $("#currentTitle").textContent = user.role === "student" ? "学生综合测评" : "学委工作台";
    $("#currentMeta").textContent = user.className ? `${user.grade || ""} ${user.major || ""} ${user.className}`.trim() : "综合测评业务工作台";
  }
  document.querySelectorAll(".tab").forEach((button) => {
    button.classList.toggle("role-hidden", !tabs.includes(button.dataset.tab));
  });
  if (user.role === "student" && user.relatedStudentId) {
    state.applyStudentId = String(user.relatedStudentId);
    $("#applyStudentId").value = String(user.relatedStudentId);
    $("#applyStudentId").readOnly = true;
  }
  const firstTab = tabs.includes(state.activeTab) ? state.activeTab : tabs[0];
  switchTab(firstTab);
}

function clearSession() {
  state.authToken = "";
  state.currentUser = null;
  localStorage.removeItem("zongce_auth_token");
  document.body.className = "auth-pending";
}

function downloadBase64File(payload) {
  const binary = atob(payload.contentBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: payload.mimeType || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = payload.fileName || "download.xlsx";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function flattenTree(nodes, depth = 0, result = []) {
  for (const node of nodes) {
    result.push({ ...node, depth });
    flattenTree(node.children || [], depth + 1, result);
  }
  return result;
}

function countNested(nodes, key) {
  let count = 0;
  for (const node of nodes) {
    count += (node[key] || []).length;
    count += countNested(node.children || [], key);
  }
  return count;
}

async function loadHealth() {
  try {
    const health = await api("/api/health");
    $("#healthText").textContent = `MySQL 已连接，${health.table_count} 张表`;
  } catch (error) {
    $("#healthText").textContent = "数据库未连接";
  }
}

async function loadRuleSets() {
  state.ruleSets = await api("/api/rule-sets");
  if (!state.selectedRuleSetId && state.ruleSets.length) {
    state.selectedRuleSetId = state.ruleSets[0].id;
  }
  renderRuleSets();
  await loadVersions();
}

async function loadVersions() {
  if (!state.selectedRuleSetId) {
    state.versions = [];
    state.selectedVersionId = null;
    state.tree = [];
    renderAll();
    return;
  }
  state.versions = await api(`/api/rule-sets/${state.selectedRuleSetId}/versions`);
  if (!state.selectedVersionId && state.versions.length) {
    state.selectedVersionId = state.versions[0].id;
  }
  if (!state.versions.some((version) => version.id === state.selectedVersionId)) {
    state.selectedVersionId = state.versions[0]?.id || null;
  }
  await loadTree();
  renderVersions();
}

async function loadTree() {
  if (!state.selectedVersionId) {
    state.tree = [];
    state.selectedNode = null;
    renderAll();
    return;
  }
  state.tree = await api(`/api/rule-versions/${state.selectedVersionId}/tree`);
  const flat = flattenTree(state.tree);
  if (state.selectedNode && !flat.some((node) => node.id === state.selectedNode.id)) {
    state.selectedNode = null;
  }
  renderAll();
}

async function loadYears() {
  state.years = await api("/api/academic-years");
  renderYears();
}

async function loadImportWorkspace() {
  const yearSelect = $("#importYearSelect");
  const selectedYearId = Number(yearSelect?.value || state.years.find((year) => year.current_snapshot_id)?.id || state.years[0]?.id || 0);
  if (yearSelect) {
    yearSelect.innerHTML = state.years
      .map((year) => `<option value="${year.id}" ${Number(year.id) === selectedYearId ? "selected" : ""}>${escapeHtml(year.name)}</option>`)
      .join("");
  }
  state.importEntries = selectedYearId ? await api(`/api/imports/entries?academicYearId=${selectedYearId}`) : [];
  const nodeSelect = $("#importRuleNodeSelect");
  if (nodeSelect) {
    nodeSelect.innerHTML = state.importEntries.length
      ? state.importEntries.map((node) => `<option value="${node.id}">${escapeHtml(node.name)} (${escapeHtml(node.code)})</option>`).join("")
      : `<option value="">当前学年没有可用规则项</option>`;
  }
  await loadImportHistory();
}

async function loadImportHistory() {
  if (!state.currentUser || !["class_committee", "college_admin", "super_admin"].includes(state.currentUser.role)) return;
  const scope = state.currentUser.role === "class_committee" ? "committee" : "college";
  state.importHistory = await api(`/api/imports/history?scope=${scope}`);
  const list = $("#importHistoryList");
  if (!list) return;
  list.innerHTML = state.importHistory.length
    ? state.importHistory
        .map(
          (row) => `<div><strong>${escapeHtml(row.file_name)}</strong><br><span>${escapeHtml(row.academic_year_name)} · ${escapeHtml(row.rule_name)} · 成功 ${row.success_rows} / 失败 ${row.failed_rows}</span></div>`
        )
        .join("")
    : `<div><span>暂无上传记录</span></div>`;
}

function selectedApplyYearId() {
  const selectValue = $("#applyYearSelect")?.value;
  if (selectValue) return Number(selectValue);
  if (state.selectedApplyYearId) return Number(state.selectedApplyYearId);
  const boundYear = state.years.find((year) => year.current_snapshot_id);
  return boundYear?.id || null;
}

function currentApplyStudentId() {
  const value = $("#applyStudentId")?.value || state.applyStudentId || "2026001";
  state.applyStudentId = value;
  return Number(value);
}

async function loadApplyEntries() {
  const yearId = selectedApplyYearId();
  if (!yearId) {
    state.applyEntries = [];
    state.selectedApplyEntry = null;
    renderApply();
    return;
  }
  state.selectedApplyYearId = yearId;
  const data = await api(`/api/apply/entries?academicYearId=${encodeURIComponent(yearId)}`);
  state.applyEntries = data.entries || [];
  if (state.selectedApplyEntry && !state.applyEntries.some((entry) => entry.id === state.selectedApplyEntry.id)) {
    state.selectedApplyEntry = null;
  }
  if (!state.selectedApplyEntry && state.applyEntries.length) {
    state.selectedApplyEntry = state.applyEntries[0];
  }
  renderApply();
}

async function loadApplyApplications() {
  const yearId = selectedApplyYearId();
  const studentId = currentApplyStudentId();
  if (!yearId || !studentId) {
    state.applyApplications = [];
    state.selectedApplyApplication = null;
    renderApply();
    return;
  }
  state.applyApplications = await api(`/api/apply/applications?academicYearId=${encodeURIComponent(yearId)}&studentId=${encodeURIComponent(studentId)}`);
  if (state.selectedApplyApplication && !state.applyApplications.some((item) => item.id === state.selectedApplyApplication.id)) {
    state.selectedApplyApplication = null;
  }
  renderApply();
}

async function loadApplyDetail(applicationId) {
  state.selectedApplyApplication = await api(`/api/apply/applications/${applicationId}`);
  const entry = state.applyEntries.find((item) => item.id === state.selectedApplyApplication.rule_node_id);
  if (entry) state.selectedApplyEntry = entry;
  renderApply();
}

async function loadApplyWorkspace() {
  if (!state.years.length) await loadYears();
  if (!state.selectedApplyYearId) state.selectedApplyYearId = selectedApplyYearId();
  await loadApplyEntries();
  await loadApplyApplications();
}

async function loadAuditApplications() {
  const status = $("#auditStatusFilter")?.value || "submitted";
  state.auditApplications = await api(`/api/audit/applications?status=${encodeURIComponent(status)}`);
  if (state.selectedAuditApplication && !state.auditApplications.some((item) => item.id === state.selectedAuditApplication.id)) {
    state.selectedAuditApplication = null;
  }
  renderAudit();
}

async function loadAuditDetail(applicationId) {
  state.selectedAuditApplication = await api(`/api/audit/applications/${applicationId}`);
  renderAudit();
}

async function loadCalcBatches() {
  state.calcBatches = await api("/api/calculation/batches");
  if (!state.selectedCalcBatchId && state.calcBatches.length) {
    state.selectedCalcBatchId = state.calcBatches[0].id;
  }
  if (state.selectedCalcBatchId) {
    await loadCalcResults(state.selectedCalcBatchId);
  } else {
    state.calcResults = [];
  }
  renderCalc();
}

async function loadCalcResults(batchId) {
  state.selectedCalcBatchId = batchId;
  state.calcResults = await api(`/api/calculation/batches/${batchId}/results`);
  state.calcDetail = null;
  renderCalc();
}

async function loadCalcDetail(batchId, studentId) {
  state.calcDetail = await api(`/api/calculation/batches/${batchId}/students/${studentId}`);
  renderCalc();
}

function selectedResultYearId() {
  return $("#resultYearSelect")?.value || state.selectedApplyYearId || selectedApplyYearId();
}

async function loadResultWorkspace() {
  const yearId = selectedResultYearId();
  const suffix = yearId ? `?academicYearId=${encodeURIComponent(yearId)}` : "";
  state.resultData = await api(`/api/results/latest${suffix}`).catch(() => null);
  state.classStats = await api(`/api/results/statistics/classes${suffix}`).catch(() => null);
  state.publicityStatus = await api(`/api/results/publicity/status${suffix}`).catch(() => null);
  state.publicityBatches = await api(`/api/results/publicity/batches${suffix}`).catch(() => []);
  renderResult();
}

async function loadClassStats() {
  const yearId = selectedResultYearId();
  const params = new URLSearchParams();
  if (yearId) params.set("academicYearId", yearId);
  if ($("#statsGradeFilter")?.value) params.set("grade", $("#statsGradeFilter").value);
  if ($("#statsMajorFilter")?.value) params.set("major", $("#statsMajorFilter").value);
  state.classStats = await api(`/api/results/statistics/classes?${params.toString()}`);
  renderResult();
}

async function loadStudents() {
  const params = new URLSearchParams();
  if ($("#studentKeyword")?.value) params.set("keyword", $("#studentKeyword").value);
  if ($("#studentGrade")?.value) params.set("grade", $("#studentGrade").value);
  if ($("#studentMajor")?.value) params.set("major", $("#studentMajor").value);
  state.students = await api(`/api/admin/students?${params.toString()}`);
  renderSystem();
}

async function loadStudentDetail(studentId) {
  state.selectedStudent = await api(`/api/admin/students/${studentId}`);
  renderSystem();
}

async function loadUsers() {
  const params = new URLSearchParams();
  if ($("#userKeyword")?.value) params.set("keyword", $("#userKeyword").value);
  if ($("#userRoleFilter")?.value) params.set("role", $("#userRoleFilter").value);
  state.users = await api(`/api/admin/users?${params.toString()}`);
  renderSystem();
}

async function loadOperationLogs() {
  const params = new URLSearchParams();
  if ($("#logModuleFilter")?.value) params.set("module", $("#logModuleFilter").value);
  state.operationLogs = await api(`/api/admin/operation-logs?${params.toString()}`);
  renderSystem();
}

function renderRuleSetsWithDelete() {
  const box = $("#ruleSetList");
  box.innerHTML = "";
  if (!state.ruleSets.length) {
    box.innerHTML = `<div class="empty">暂无规则集</div>`;
    return;
  }
  for (const item of state.ruleSets) {
    const btn = document.createElement("button");
    btn.className = `list-item ${item.id === state.selectedRuleSetId ? "active" : ""}`;
    btn.innerHTML = `<strong>${item.name}</strong><span>${item.status} · ${item.version_count || 0} 个版本</span>`;
    btn.onclick = async () => {
      state.selectedRuleSetId = item.id;
      state.selectedVersionId = null;
      state.selectedNode = null;
      await loadVersions();
      renderRuleSets();
    };
    box.appendChild(btn);
  }
}

function renderRuleSets() {
  const box = $("#ruleSetList");
  box.innerHTML = "";
  if (!state.ruleSets.length) {
    box.innerHTML = `<div class="empty">暂无规则集</div>`;
    return;
  }
  for (const item of state.ruleSets) {
    const row = document.createElement("div");
    row.className = "list-row";
    const btn = document.createElement("button");
    btn.className = `list-item ${item.id === state.selectedRuleSetId ? "active" : ""}`;
    btn.innerHTML = `<strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.status)} · ${item.version_count || 0} 个版本</span>`;
    btn.onclick = async () => {
      state.selectedRuleSetId = item.id;
      state.selectedVersionId = null;
      state.selectedNode = null;
      await loadVersions();
      renderRuleSets();
    };
    const del = document.createElement("button");
    del.className = "danger-btn";
    del.textContent = "删除";
    del.title = "删除或归档规则集";
    del.onclick = async () => {
      if (!confirm(`确认删除/归档规则集：${item.name}？`)) return;
      const result = await api(`/api/rule-sets/${item.id}`, { method: "DELETE" });
      if (state.selectedRuleSetId === item.id) {
        state.selectedRuleSetId = null;
        state.selectedVersionId = null;
      }
      await loadRuleSets();
      toast(result.deleted ? "规则集已删除" : "规则集已有业务数据，已归档");
    };
    row.appendChild(btn);
    row.appendChild(del);
    box.appendChild(row);
  }
}


function renderVersions() {
  const box = $("#versionList");
  box.innerHTML = "";
  if (!state.versions.length) {
    box.innerHTML = `<div class="empty">暂无版本</div>`;
    return;
  }
  for (const item of state.versions) {
    const btn = document.createElement("button");
    btn.className = `list-item ${item.id === state.selectedVersionId ? "active" : ""}`;
    btn.innerHTML = `<strong>${item.version_no}</strong><span>${item.status} · ${item.version_name || "未命名"}</span>`;
    btn.onclick = async () => {
      state.selectedVersionId = item.id;
      state.selectedNode = null;
      await loadTree();
      renderVersions();
    };
    box.appendChild(btn);
  }
}

function renderTree() {
  const box = $("#ruleTree");
  box.innerHTML = "";
  if (!state.tree.length) {
    box.innerHTML = `<div class="empty">暂无规则节点</div>`;
    return;
  }
  const renderNodes = (nodes, container) => {
    for (const node of nodes) {
      const wrap = document.createElement("div");
      wrap.className = "tree-node";
      const btn = document.createElement("button");
      btn.className = `node-button ${state.selectedNode?.id === node.id ? "active" : ""}`;
      btn.innerHTML = `
        <div>
          <div class="node-name">${node.name}</div>
          <div class="node-meta">${node.code} · ${ruleNodeTypeLabel(node)} · ${node.aggregation_type || "无汇总"}</div>
        </div>
        <span class="tag">${node.node_type === "aggregate" ? `${node.max_score ?? "不限"} 分上限` : "按计分配置"}</span>
      `;
      btn.onclick = () => {
        state.selectedNode = node;
        renderAll();
      };
      wrap.appendChild(btn);
      if (node.children?.length) {
        renderNodes(node.children, wrap);
      }
      container.appendChild(wrap);
    }
  };
  renderNodes(state.tree, box);
}

function renderParentSelect() {
  const select = $("#parentSelect");
  const flat = flattenTree(state.tree);
  select.innerHTML = `<option value="">无父节点</option>`;
  for (const node of flat.filter((item) => item.node_type === "aggregate")) {
    const option = document.createElement("option");
    option.value = node.id;
    option.textContent = `${"  ".repeat(node.depth)}${node.name}`;
    if (state.selectedNode?.id === node.id) option.selected = true;
    select.appendChild(option);
  }
}

function renderNodeDetails() {
  const box = $("#selectedNodeBox");
  const deleteButton = $("#deleteNodeBtn");
  const itemOnlyFormIds = ["#calcForm", "#fieldForm", "#materialForm", "#auditForm", "#groupRuleForm"];
  const itemSelected = state.selectedNode?.node_type === "item";
  itemOnlyFormIds.forEach((selector) => {
    const form = $(selector);
    if (form) form.hidden = Boolean(state.selectedNode) && !itemSelected;
  });
  if (deleteButton) deleteButton.disabled = !state.selectedNode;
  if (!state.selectedNode) {
    box.textContent = "尚未选择节点";
    return;
  }
  const node = state.selectedNode;
  const detail = (title, rows, mapper) => {
    if (!rows?.length) return `<div class="detail-line">${title}：暂无</div>`;
    return `<div class="detail-group"><strong>${title}</strong>${rows.map(mapper).join("")}</div>`;
  };
  box.innerHTML = `
    <strong>${node.name}</strong>
    <div class="node-meta">${node.code} · ${ruleNodeTypeLabel(node)} · ${node.is_apply_entry ? "可申报" : "不可申报"}</div>
    ${detail("计分配置", node.calculation_configs, (row) => `<div class="detail-line">${row.config_type} ${row.formula_code || ""}<br>${JSON.stringify(row.config_json)}</div>`)}
    ${detail("申报字段", node.form_fields, (row) => `<div class="detail-line">${row.field_label} (${row.field_key}) · ${row.field_type}</div>`)}
    ${detail("材料要求", node.material_requirements, (row) => `<div class="detail-line">${row.material_name} · ${row.file_type_limit || "不限"} · ${row.max_file_count}份</div>`)}
    ${detail("审核要求", node.audit_requirements, (row) => `<div class="detail-line">${row.audit_role} · ${row.need_second_audit ? "需要复核" : "不复核"}<br>${row.audit_instruction || ""}</div>`)}
    ${detail("适用范围", node.scopes, (row) => `<div class="detail-line">${row.include_or_exclude} ${row.scope_type}: ${row.scope_value}</div>`)}
    ${detail("团体分配", node.group_distribution_rules, (row) => `<div class="detail-line">${row.distribution_type}<br>${JSON.stringify(row.config_json)}</div>`)}
  `;
}

function renderMetrics() {
  const flat = flattenTree(state.tree);
  $("#nodeCount").textContent = flat.length;
  $("#applyEntryCount").textContent = flat.filter((node) => node.is_apply_entry).length;
  $("#fieldCount").textContent = countNested(state.tree, "form_fields");
  $("#materialCount").textContent = countNested(state.tree, "material_requirements");
}

function renderTitle() {
  if (state.currentUser && ["student", "class_committee"].includes(state.currentUser.role)) {
    $("#currentTitle").textContent = state.currentUser.role === "student" ? "学生综合测评" : "学委工作台";
    $("#currentMeta").textContent = state.currentUser.className
      ? `${state.currentUser.grade || ""} ${state.currentUser.major || ""} ${state.currentUser.className}`.trim()
      : "综合测评业务工作台";
    return;
  }
  const version = state.versions.find((item) => item.id === state.selectedVersionId);
  const ruleSet = state.ruleSets.find((item) => item.id === state.selectedRuleSetId);
  $("#currentTitle").textContent = version ? `${ruleSet?.name || "规则集"} · ${version.version_no}` : "未选择规则版本";
  $("#currentMeta").textContent = version
    ? `${version.status} · ${version.version_name || "未命名版本"}`
    : "创建示例数据后，可以验证规则树和配置项是否落表。";
}

function renderYears() {
  // 普通删除会归档已有业务数据的学年；独立的红色按钮调用最高管理员接口，
  // 并要求再次输入完整学年名称确认。
  const select = $("#yearSelect");
  if (select) {
    select.innerHTML = "";
    for (const year of state.years) {
      const option = document.createElement("option");
      option.value = year.id;
      option.textContent = `${year.name}${year.rule_set_version_id ? " · 已绑定规则" : ""}`;
      select.appendChild(option);
    }
  }
  const resultSelect = $("#resultYearSelect");
  if (resultSelect) {
    const current = resultSelect.value;
    resultSelect.innerHTML = "";
    for (const year of state.years) {
      const option = document.createElement("option");
      option.value = year.id;
      option.textContent = year.name;
      if (String(year.id) === String(current)) option.selected = true;
      resultSelect.appendChild(option);
    }
  }
  const list = $("#yearList");
  if (!list) return;
  list.innerHTML = "";
  for (const year of state.years) {
    const row = document.createElement("div");
    row.innerHTML = `<strong>${escapeHtml(year.name)}</strong><br><span>${escapeHtml(year.status)} · 快照 ${year.current_snapshot_id || "未绑定"}</span>`;
    const del = document.createElement("button");
    del.className = "danger-btn";
    del.textContent = "删除/归档";
    del.onclick = async () => {
      try {
        if (!confirm(`确认删除/归档学年：${year.name}？`)) return;
        const result = await api(`/api/academic-years/${year.id}`, { method: "DELETE" });
        await loadYears();
        renderAll();
        toast(result.deleted ? "学年已删除" : "学年已有业务数据，已归档");
      } catch (error) {
        toast(error.message);
      }
    };
    const forceDelete = document.createElement("button");
      forceDelete.className = "danger-btn danger-solid";
      forceDelete.textContent = "彻底删除";
      forceDelete.title = "仅最高管理员可用，将删除该学年的全部业务数据";
      forceDelete.hidden = state.currentUser?.role !== "super_admin";
      forceDelete.onclick = async () => {
        try {
          if (state.currentUser?.role !== "super_admin") {
            throw new Error("只有最高管理员可以彻底删除学年");
          }
          const confirmName = prompt(`此操作不可恢复。请输入学年名称“${year.name}”确认：`);
        if (confirmName !== year.name) {
          toast("学年名称不一致，已取消删除");
          return;
        }
          const result = await api(
            `/api/academic-years/${year.id}?force=true&confirmName=${encodeURIComponent(confirmName)}`,
            { method: "DELETE" }
          );
        if (Number(state.selectedApplyYearId) === Number(year.id)) state.selectedApplyYearId = null;
        await loadYears();
        renderAll();
        toast(`学年已彻底删除，共清理 ${result.deleted_data.application_count} 条申报`);
      } catch (error) {
        toast(error.message);
      }
    };
    row.appendChild(document.createElement("br"));
    row.appendChild(del);
    row.appendChild(forceDelete);
    list.appendChild(row);
  }
}

function applicationFieldMap(application) {
  const map = new Map();
  for (const row of application?.fields || []) {
    map.set(row.field_key, row.field_value);
  }
  return map;
}

function renderApplyYearSelect() {
  const select = $("#applyYearSelect");
  if (!select) return;
  const selected = state.selectedApplyYearId || selectedApplyYearId();
  select.innerHTML = "";
  for (const year of state.years.filter((item) => item.current_snapshot_id)) {
    const option = document.createElement("option");
    option.value = year.id;
    option.textContent = year.name;
    if (Number(year.id) === Number(selected)) option.selected = true;
    select.appendChild(option);
  }
}

function renderApplyEntries() {
  const list = $("#applyEntryList");
  if (!list) return;
  list.innerHTML = "";
  if (!state.applyEntries.length) {
    list.innerHTML = `<div><span>当前学年暂无可申报项目，请先绑定规则快照</span></div>`;
    return;
  }
  for (const entry of state.applyEntries) {
    const btn = document.createElement("button");
    btn.className = `record-button ${state.selectedApplyEntry?.id === entry.id ? "active" : ""}`;
    btn.innerHTML = `
      <strong>${escapeHtml(entry.name)}</strong><br>
      <span>${escapeHtml(entry.path_name || entry.code)}</span><br>
      <span>${(entry.form_fields || []).length} 个字段 · ${(entry.material_requirements || []).length} 类材料</span>
    `;
    btn.onclick = () => {
      state.selectedApplyEntry = entry;
      state.selectedApplyApplication = null;
      renderApply();
    };
    list.appendChild(btn);
  }
}

function renderFieldControl(field, value) {
  const key = escapeHtml(field.field_key);
  const type = field.field_type;
  const common = `data-apply-field="${key}" data-field-type="${escapeHtml(type)}"`;
  const safeValue = value === undefined || value === null ? "" : value;
  if (type === "select") {
    const options = optionValues(field.options_json);
    return `<select ${common}>${options
      .map((option) => `<option value="${escapeHtml(option)}" ${String(option) === String(safeValue) ? "selected" : ""}>${escapeHtml(option)}</option>`)
      .join("")}</select>`;
  }
  if (type === "multi_select") {
    const selected = Array.isArray(safeValue) ? safeValue.map(String) : [];
    const options = optionValues(field.options_json);
    return `<select ${common} multiple>${options
      .map((option) => `<option value="${escapeHtml(option)}" ${selected.includes(String(option)) ? "selected" : ""}>${escapeHtml(option)}</option>`)
      .join("")}</select>`;
  }
  if (type === "number") {
    return `<input ${common} type="number" step="0.001" value="${escapeHtml(safeValue)}" />`;
  }
  if (type === "date") {
    return `<input ${common} type="date" value="${escapeHtml(safeValue)}" />`;
  }
  if (type === "textarea") {
    return `<textarea ${common} rows="3">${escapeHtml(safeValue)}</textarea>`;
  }
  return `<input ${common} value="${escapeHtml(safeValue)}" />`;
}

function renderApplyEditor() {
  const editor = $("#applyEditor");
  const materialSelect = $("#materialRequirementSelect");
  if (!editor || !materialSelect) return;
  materialSelect.innerHTML = "";
  const entry = state.selectedApplyEntry;
  if (!entry) {
    editor.textContent = "请选择一个可申报项目";
    return;
  }

  const app = state.selectedApplyApplication?.rule_node_id === entry.id ? state.selectedApplyApplication : null;
  const fields = applicationFieldMap(app);
  const title = app?.title || entry.name;
  const fieldHtml = (entry.form_fields || [])
    .map((field) => {
      const required = field.required ? " *" : "";
      return `<label>${escapeHtml(field.field_label)}${required}${renderFieldControl(field, fields.get(field.field_key))}</label>`;
    })
    .join("");
  const materialHtml = (entry.material_requirements || [])
    .map(
      (row) =>
        `<div class="material-pill"><strong>${escapeHtml(row.material_name)}</strong><br>${row.required ? "必需" : "可选"} · ${escapeHtml(row.file_type_limit || "不限")} · 最多 ${row.max_file_count || 1} 个<br>${escapeHtml(row.description || "")}</div>`
    )
    .join("");

  for (const material of entry.material_requirements || []) {
    const option = document.createElement("option");
    option.value = material.id;
    option.textContent = `${material.material_name}${material.required ? "（必需）" : ""}`;
    materialSelect.appendChild(option);
  }

  const members = app?.members?.length
    ? app.members
    : [{ member_student_id: currentApplyStudentId(), member_name: "", role_name: "本人", rank_no: 1, contribution_ratio: 1 }];

  editor.innerHTML = `
    <label>
      申报标题
      <input id="applyTitle" value="${escapeHtml(title)}" />
    </label>
    <div class="apply-field-list">${fieldHtml || '<div class="detail-line">该规则项暂无额外字段</div>'}</div>
    <label>
      团队成员 JSON
      <textarea id="applyMembersJson" rows="5">${escapeHtml(JSON.stringify(members, null, 2))}</textarea>
    </label>
    <div class="material-pill-list">${materialHtml || '<div class="material-pill">该规则项暂无材料要求</div>'}</div>
  `;
}

function renderApplyApplications() {
  const list = $("#studentApplicationList");
  const detail = $("#studentApplicationDetail");
  if (!list || !detail) return;
  list.innerHTML = "";
  if (!state.applyApplications.length) {
    list.innerHTML = `<div><span>暂无申报记录</span></div>`;
  } else {
    for (const item of state.applyApplications) {
      const btn = document.createElement("button");
      btn.className = `record-button ${state.selectedApplyApplication?.id === item.id ? "active" : ""}`;
      btn.innerHTML = `
        <strong>${escapeHtml(item.title || item.rule_name)}</strong><br>
        <span>${statusLabel(item.status)} · ${item.attachment_count || 0} 个材料 · 第 ${item.current_revision_no || 0} 版</span><br>
        <span>${escapeHtml(item.rule_code)}</span>
      `;
      btn.onclick = () => loadApplyDetail(item.id);
      list.appendChild(btn);
    }
  }

  const app = state.selectedApplyApplication;
  if (!app) {
    detail.textContent = "请选择一条申报记录";
    return;
  }
  const fieldHtml = (app.fields || [])
    .map((row) => `<div class="detail-line">${escapeHtml(row.field_key)}: ${escapeHtml(JSON.stringify(row.field_value))}</div>`)
    .join("");
  const attachmentHtml = (app.attachments || [])
    .map(
      (row) =>
        `<div class="detail-line">${escapeHtml(row.file_name)} · ${escapeHtml(row.status)} · ${escapeHtml(row.review_result || "pending")}<br><a href="${escapeHtml(row.file_url)}" target="_blank">${escapeHtml(row.file_url)}</a></div>`
    )
    .join("");
  const revisionHtml = (app.revisions || [])
    .map((row) => `<div class="detail-line">第 ${row.revision_no} 版 · ${escapeHtml(row.submit_type)} · ${escapeHtml(row.submitted_at || "")}</div>`)
    .join("");
  detail.innerHTML = `
    <strong>${escapeHtml(app.title || app.rule_name)}</strong>
    <div class="node-meta">${escapeHtml(app.rule_code)} · ${statusLabel(app.status)} · 学生 ${app.student_id}</div>
    <div class="detail-group"><strong>字段</strong>${fieldHtml || '<div class="detail-line">无</div>'}</div>
    <div class="detail-group"><strong>材料</strong>${attachmentHtml || '<div class="detail-line">无</div>'}</div>
    <div class="detail-group"><strong>提交版本</strong>${revisionHtml || '<div class="detail-line">尚未提交</div>'}</div>
  `;
}

function renderApply() {
  if (!$("#tab-apply")) return;
  const studentInput = $("#applyStudentId");
  if (studentInput && studentInput.value !== state.applyStudentId) studentInput.value = state.applyStudentId;
  renderApplyYearSelect();
  renderApplyEntries();
  renderApplyEditor();
  renderApplyApplications();
}

function renderAudit() {
  const list = $("#auditApplicationList");
  if (!list) return;
  list.innerHTML = "";
  if (!state.auditApplications.length) {
    list.innerHTML = `<div><span>暂无申报记录</span></div>`;
  } else {
    for (const app of state.auditApplications) {
      const btn = document.createElement("button");
      btn.className = `record-button ${state.selectedAuditApplication?.id === app.id ? "active" : ""}`;
      btn.innerHTML = `
        <strong>${app.title || app.rule_name}</strong><br>
        <span>学生 ${app.student_id} · ${app.status} · ${app.audit_stage || "未进入审核"}</span><br>
        <span>${app.rule_code}</span>
      `;
      btn.onclick = () => loadAuditDetail(app.id);
      list.appendChild(btn);
    }
  }

  const detail = $("#auditDetail");
  if (!detail) return;
  const app = state.selectedAuditApplication;
  if (!app) {
    detail.textContent = "请选择一条申报记录";
    return;
  }
  const fieldHtml = (app.fields || [])
    .map((row) => `<div class="detail-line">${row.field_key}: ${JSON.stringify(row.field_value)}</div>`)
    .join("");
  const attachmentHtml = (app.attachments || [])
    .map((row) => {
      const fileUrl = String(row.file_url || "");
      const canOpen = fileUrl.startsWith("/uploads/");
      const mimeType = String(row.mime_type || "").toLowerCase();
      let preview = `<div class="material-unavailable">该测试材料没有可打开的实体文件</div>`;
      if (canOpen && mimeType === "application/pdf") {
        preview = `<iframe class="audit-material-frame" src="${escapeHtml(fileUrl)}" title="${escapeHtml(row.file_name)}"></iframe>`;
      } else if (canOpen && mimeType.startsWith("image/")) {
        preview = `<img class="audit-material-image" src="${escapeHtml(fileUrl)}" alt="${escapeHtml(row.file_name)}" />`;
      } else if (canOpen) {
        preview = `<a class="material-open-link" href="${escapeHtml(fileUrl)}" target="_blank" rel="noopener">打开材料文件</a>`;
      }
      return `
        <article class="audit-material">
          <div class="audit-material-head">
            <div><strong>${escapeHtml(row.file_name)}</strong><span>${escapeHtml(row.mime_type || "未知类型")} · ${escapeHtml(row.review_result || "pending")}</span></div>
            ${canOpen ? `<a href="${escapeHtml(fileUrl)}" target="_blank" rel="noopener">新窗口打开</a>` : ""}
          </div>
          ${preview}
        </article>`;
    })
    .join("");
  const auditHtml = (app.audits || [])
    .map((row) => `<div class="detail-line">${row.audit_role} · ${row.audit_result}<br>${row.audit_comment || ""}</div>`)
    .join("");
  let aiAuditHtml = "";
  const aiAudits = app.ai_audits || [];
  if (aiAudits.length) {
    const overallRecord = aiAudits.find(r => r.attachment_id === null);
    const perAttachment = aiAudits.filter(r => r.attachment_id !== null);
    aiAuditHtml = `<div class="detail-group" style="border:1px solid #6366f1;border-radius:8px;padding:12px;margin:8px 0;background:#f5f3ff">
      <strong style="color:#4338ca">AI 自动审核结果</strong>`;
    if (overallRecord) {
      const matchIcon = overallRecord.match_success ? "通过" : "不通过";
      aiAuditHtml += `<div class="detail-line" style="margin-top:6px"><strong>综合结论：</strong>${matchIcon} — ${escapeHtml(overallRecord.match_detail || "")}</div>`;
      aiAuditHtml += `<div class="detail-line"><strong>上传学生：</strong>${escapeHtml(overallRecord.student_name)}</div>`;
      if (overallRecord.recognized_names?.length) {
        aiAuditHtml += `<div class="detail-line"><strong>AI识别姓名：</strong>${escapeHtml(overallRecord.recognized_names.join("、"))}</div>`;
      }
    }
    if (perAttachment.length) {
      for (const rec of perAttachment) {
        aiAuditHtml += `<div class="detail-line" style="margin:4px 0;padding:4px 8px;background:#eef;border-radius:4px">${escapeHtml(rec.match_detail || "")}</div>`;
      }
    }
    aiAuditHtml += `</div>`;
  }

  detail.innerHTML = `
    <strong>${app.title || app.rule_name}</strong>
    <div class="node-meta">${app.rule_code} · 学生 ${app.student_id} · ${app.status}</div>
    <div class="detail-group"><strong>字段</strong>${fieldHtml || '<div class="detail-line">无</div>'}</div>
    <div class="detail-group"><strong>学生上传材料</strong>${attachmentHtml || '<div class="detail-line">无</div>'}</div>
    ${aiAuditHtml}
    <div class="detail-group"><strong>审核记录</strong>${auditHtml || '<div class="detail-line">暂无</div>'}</div>
  `;
}

function renderCalc() {
  const batchList = $("#calcBatchList");
  if (!batchList) return;
  batchList.innerHTML = "";
  if (!state.calcBatches.length) {
    batchList.innerHTML = `<div><span>暂无核算批次</span></div>`;
  } else {
    for (const batch of state.calcBatches) {
      const btn = document.createElement("button");
      btn.className = `record-button ${state.selectedCalcBatchId === batch.id ? "active" : ""}`;
      btn.innerHTML = `
        <strong>批次 #${batch.id}</strong><br>
        <span>${batch.batch_type} · ${batch.status} · 结果 ${batch.result_count || 0} 条</span><br>
        <span>${batch.created_at || ""}</span>
      `;
      btn.onclick = () => loadCalcResults(batch.id);
      batchList.appendChild(btn);
    }
  }

  const resultList = $("#calcResultList");
  resultList.innerHTML = "";
  if (!state.calcResults.length) {
    resultList.innerHTML = `<div><span>暂无核算结果</span></div>`;
  } else {
    for (const row of state.calcResults) {
      const btn = document.createElement("button");
      btn.className = "record-button";
      btn.innerHTML = `<strong>第 ${row.rank_no || "-"} 名 · 学生 ${row.student_id}</strong><br><span>总分 ${row.total_score}</span>`;
      btn.onclick = () => loadCalcDetail(row.batch_id, row.student_id);
      resultList.appendChild(btn);
    }
  }

  const detail = $("#calcDetail");
  if (!state.calcDetail) {
    detail.textContent = "请选择一条核算结果";
    return;
  }
  const itemHtml = (state.calcDetail.items || [])
    .map((row) => `<div class="detail-line">${row.rule_name}: ${row.raw_score} / ${row.effective_score}<br>${JSON.stringify(row.calculation_detail_json)}</div>`)
    .join("");
  const nodeHtml = (state.calcDetail.nodes || [])
    .map((row) => `<div class="detail-line">${row.node_name}: 原始 ${row.raw_score}，计入 ${row.effective_score}</div>`)
    .join("");
  const warningHtml = (state.calcDetail.warnings || [])
    .map((row) => `<div class="detail-line">${row.warning_type}: ${row.warning_message}</div>`)
    .join("");
  const errorHtml = (state.calcDetail.errors || [])
    .map((row) => `<div class="detail-line">${row.error_type}: ${row.error_message}</div>`)
    .join("");
  detail.innerHTML = `
    <div class="detail-group"><strong>单项得分</strong>${itemHtml || '<div class="detail-line">无</div>'}</div>
    <div class="detail-group"><strong>节点汇总</strong>${nodeHtml || '<div class="detail-line">无</div>'}</div>
    <div class="detail-group"><strong>提醒</strong>${warningHtml || '<div class="detail-line">无</div>'}</div>
    <div class="detail-group"><strong>错误</strong>${errorHtml || '<div class="detail-line">无</div>'}</div>
  `;
}

function renderResult() {
  if (!$("#tab-result")) return;
  renderYears();
  const data = state.resultData;
  $("#resultBatchId").textContent = data?.batch?.id || "-";
  $("#resultStudentCount").textContent = data?.rows?.length || 0;
  $("#resultClassCount").textContent = state.classStats?.summary?.class_count || 0;
  $("#publicityStateText").textContent = state.publicityStatus?.status || "未公示";

  const resultList = $("#resultList");
  if (resultList) {
    resultList.innerHTML = "";
    const rows = data?.rows || [];
    if (!rows.length) {
      resultList.innerHTML = `<div><span>暂无核算结果</span></div>`;
    } else {
      for (const row of rows.slice(0, 80)) {
        const item = document.createElement("div");
        item.innerHTML = `<strong>第 ${row.rank_no || "-"} 名 · ${escapeHtml(row.student_name || row.student_id)}</strong><br><span>${escapeHtml(row.student_no || row.student_id)} · ${escapeHtml(row.class_name || "")} · 总分 ${row.total_score}</span>`;
        resultList.appendChild(item);
      }
    }
  }

  const classList = $("#classStatsList");
  if (classList) {
    classList.innerHTML = "";
    const rows = state.classStats?.rows || [];
    if (!rows.length) {
      classList.innerHTML = `<div><span>暂无行政班统计</span></div>`;
    } else {
      for (const row of rows) {
        const item = document.createElement("div");
        item.innerHTML = `<strong>${escapeHtml(row.grade)} · ${escapeHtml(row.major)} · ${escapeHtml(row.class_name)}</strong><br><span>${row.student_count} 人 · 平均 ${row.avg_score} · 最高 ${row.max_score} · 最低 ${row.min_score}</span>`;
        classList.appendChild(item);
      }
    }
  }

  const pubList = $("#publicityBatchList");
  if (pubList) {
    pubList.innerHTML = "";
    if (!state.publicityBatches.length) {
      pubList.innerHTML = `<div><span>暂无公示批次</span></div>`;
    } else {
      for (const batch of state.publicityBatches) {
        const item = document.createElement("div");
        item.innerHTML = `<strong>第 ${batch.publicity_round} 轮 · ${escapeHtml(batch.status)}</strong><br><span>核算批次 #${batch.calculation_batch_id} · ${batch.result_count || 0} 条 · ${escapeHtml(batch.start_time || "")}</span>`;
        pubList.appendChild(item);
      }
    }
  }
}

function fillStudentForm(student) {
  const form = $("#studentForm");
  if (!form) return;
  form.elements.id.value = student?.id || "";
  form.elements.studentNo.value = student?.student_no || "";
  form.elements.name.value = student?.name || "";
  form.elements.grade.value = student?.grade || "";
  form.elements.major.value = student?.major || "";
  form.elements.className.value = student?.class_name || student?.administrative_class || "";
  form.elements.status.value = student?.status || "active";
  form.elements.phone.value = student?.phone || "";
  form.elements.email.value = student?.email || "";
  form.elements.studentType.value = student?.student_type || "normal";
}

function fillUserForm(user) {
  const form = $("#userForm");
  if (!form) return;
  form.elements.id.value = user?.id || "";
  form.elements.username.value = user?.username || "";
  form.elements.displayName.value = user?.display_name || "";
  form.elements.password.value = "123456";
  form.elements.role.value = user?.role || "student";
  form.elements.status.value = user?.status || "active";
  form.elements.email.value = user?.email || "";
  form.elements.relatedStudentId.value = user?.related_student_id || "";
}

function renderSystem() {
  if (!$("#tab-system")) return;
  document.querySelectorAll(".sub-tab").forEach((btn) => btn.classList.toggle("active", btn.dataset.systemTab === state.systemTab));
  document.querySelectorAll(".system-page").forEach((page) => page.classList.toggle("active", page.id === `system-${state.systemTab}`));

  const studentList = $("#studentList");
  if (studentList) {
    studentList.innerHTML = "";
    if (!state.students.length) {
      studentList.innerHTML = `<div><span>暂无学生</span></div>`;
    } else {
      for (const student of state.students) {
        const btn = document.createElement("button");
        btn.className = `record-button ${state.selectedStudent?.id === student.id ? "active" : ""}`;
        btn.innerHTML = `<strong>${escapeHtml(student.name)} · ${escapeHtml(student.student_no)}</strong><br><span>${escapeHtml(student.grade || "")} · ${escapeHtml(student.major || "")} · ${escapeHtml(student.class_name || "")} · ${escapeHtml(student.status)}</span>`;
        btn.onclick = () => loadStudentDetail(student.id);
        studentList.appendChild(btn);
      }
    }
  }
  if (state.selectedStudent) {
    fillStudentForm(state.selectedStudent);
    const detail = $("#studentDetail");
    if (detail) {
      const appCount = state.selectedStudent.applications?.length || 0;
      const scoreCount = state.selectedStudent.totals?.length || 0;
      detail.innerHTML = `<strong>${escapeHtml(state.selectedStudent.name)} ${escapeHtml(state.selectedStudent.student_no)}</strong><br><span>${escapeHtml(state.selectedStudent.major || "")} · ${escapeHtml(state.selectedStudent.class_name || "")}</span><div class="detail-group"><div class="detail-line">申报记录 ${appCount} 条</div><div class="detail-line">成绩记录 ${scoreCount} 条</div></div>`;
    }
  }

  const userList = $("#userList");
  if (userList) {
    userList.innerHTML = "";
    if (!state.users.length) {
      userList.innerHTML = `<div><span>暂无用户</span></div>`;
    } else {
      for (const user of state.users) {
        const btn = document.createElement("button");
        btn.className = `record-button ${state.selectedUser?.id === user.id ? "active" : ""}`;
        btn.innerHTML = `<strong>${escapeHtml(user.display_name)} · ${escapeHtml(user.username)}</strong><br><span>${escapeHtml(user.role)} · ${escapeHtml(user.status)} · ${escapeHtml(user.email || "")}</span>`;
        btn.onclick = () => {
          state.selectedUser = user;
          fillUserForm(user);
          renderSystem();
        };
        userList.appendChild(btn);
      }
    }
  }

  const logList = $("#operationLogList");
  if (logList) {
    logList.innerHTML = "";
    if (!state.operationLogs.length) {
      logList.innerHTML = `<div><span>暂无操作日志</span></div>`;
    } else {
      for (const log of state.operationLogs) {
        const item = document.createElement("div");
        item.innerHTML = `<strong>${escapeHtml(log.module)} · ${escapeHtml(log.operation_type)}</strong><br><span>${escapeHtml(log.created_at || "")} · ${escapeHtml(log.target_type || "")} #${log.target_id || ""}</span>`;
        logList.appendChild(item);
      }
    }
  }
}

function renderAll() {
  renderTitle();
  renderTree();
  renderParentSelect();
  renderNodeDetails();
  renderMetrics();
  renderYears();
  renderApply();
  renderAudit();
  renderCalc();
  renderResult();
  renderSystem();
}

function switchTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll(".tab").forEach((btn) => btn.classList.toggle("active", btn.dataset.tab === tab));
  document.querySelectorAll(".tab-page").forEach((page) => page.classList.toggle("active", page.id === `tab-${tab}`));
  if (tab === "apply") loadApplyWorkspace().catch((error) => toast(error.message));
  if (tab === "audit") loadAuditApplications().catch((error) => toast(error.message));
  if (tab === "import") loadImportWorkspace().catch((error) => toast(error.message));
  if (tab === "calc") loadCalcBatches().catch((error) => toast(error.message));
  if (tab === "result") loadResultWorkspace().catch((error) => toast(error.message));
  if (tab === "system") {
    Promise.all([loadStudents(), loadUsers(), loadOperationLogs()]).catch((error) => toast(error.message));
  }
}

function requireVersion() {
  if (!state.selectedVersionId) throw new Error("请先选择规则版本");
}

function requireNode() {
  if (!state.selectedNode) throw new Error("请先选择规则节点");
}

function collectApplyFieldValues() {
  const values = {};
  document.querySelectorAll("[data-apply-field]").forEach((input) => {
    const key = input.dataset.applyField;
    const type = input.dataset.fieldType;
    if (type === "multi_select") {
      values[key] = Array.from(input.selectedOptions).map((option) => option.value);
    } else if (type === "number") {
      values[key] = input.value === "" ? null : Number(input.value);
    } else {
      values[key] = input.value;
    }
  });
  return values;
}

function collectApplyMembers() {
  const raw = $("#applyMembersJson")?.value || "[]";
  const members = parseJsonInput(raw, []);
  if (!Array.isArray(members)) throw new Error("团队成员 JSON 必须是数组");
  return members;
}

function canEditSelectedApplyApplication() {
  const app = state.selectedApplyApplication;
  return app && app.rule_node_id === state.selectedApplyEntry?.id && ["draft", "returned"].includes(app.status);
}

async function saveApplyDraft() {
  const entry = state.selectedApplyEntry;
  const yearId = selectedApplyYearId();
  const studentId = currentApplyStudentId();
  if (!entry) throw new Error("请先选择可申报项目");
  if (!yearId) throw new Error("请先选择申报学年");
  if (!studentId) throw new Error("请填写学生ID");
  const payload = {
    academicYearId: yearId,
    ruleNodeId: entry.id,
    studentId,
    title: $("#applyTitle")?.value || entry.name,
    fieldValues: collectApplyFieldValues(),
    members: collectApplyMembers()
  };
  const detail = canEditSelectedApplyApplication()
    ? await api(`/api/apply/applications/${state.selectedApplyApplication.id}`, {
        method: "PUT",
        body: JSON.stringify(payload)
      })
    : await api("/api/apply/applications", {
        method: "POST",
        body: JSON.stringify(payload)
      });
  state.selectedApplyApplication = detail;
  await loadApplyApplications();
  state.selectedApplyApplication = detail;
  renderApply();
  return detail;
}

async function submitCurrentApplyApplication() {
  const app = await saveApplyDraft();
  const data = await api(`/api/apply/applications/${app.id}/submit`, {
    method: "POST",
    body: JSON.stringify({ studentId: currentApplyStudentId() })
  });
  state.selectedApplyApplication = data.detail;
  await loadApplyApplications();
  state.selectedApplyApplication = data.detail;
  renderApply();
  return data;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function wireEvents() {
  $("#refreshBtn").onclick = async () => {
    await refresh();
    toast("已刷新");
  };

  $("#seedBtn").onclick = async () => {
    const data = await api("/api/dev/seed", { method: "POST", body: "{}" });
    state.selectedRuleSetId = data.ruleSetId;
    state.selectedVersionId = data.versionId;
    await refresh();
    toast("示例规则已载入");
  };

  $("#publishBtn").onclick = async () => {
    requireVersion();
    await api(`/api/rule-versions/${state.selectedVersionId}/publish`, { method: "POST", body: "{}" });
    await loadVersions();
    toast("版本已发布");
  };

  $("#deleteRuleSetBtn").onclick = async () => {
    if (!state.selectedRuleSetId) throw new Error("请先选择规则集");
    const ruleSet = state.ruleSets.find((item) => item.id === state.selectedRuleSetId);
    if (!confirm(`确认删除/归档当前规则集：${ruleSet?.name || state.selectedRuleSetId}？`)) return;
    const result = await api(`/api/rule-sets/${state.selectedRuleSetId}`, { method: "DELETE" });
    state.selectedRuleSetId = null;
    state.selectedVersionId = null;
    state.selectedNode = null;
    await loadRuleSets();
    toast(result.deleted ? "规则集已删除" : "规则集已有业务数据，已归档");
  };

  document.querySelectorAll(".tab").forEach((btn) => {
    btn.onclick = () => switchTab(btn.dataset.tab);
  });

  $("#ruleSetForm").onsubmit = async (event) => {
    event.preventDefault();
    const data = formData(event.target);
    const result = await api("/api/rule-sets", {
      method: "POST",
      body: JSON.stringify({ name: data.name, description: data.description })
    });
    state.selectedRuleSetId = result.id;
    state.selectedVersionId = null;
    await loadRuleSets();
    toast("规则集已创建");
    event.target.reset();
  };

  $("#versionForm").onsubmit = async (event) => {
    event.preventDefault();
    if (!state.selectedRuleSetId) throw new Error("请先选择规则集");
    const data = formData(event.target);
    const result = await api(`/api/rule-sets/${state.selectedRuleSetId}/versions`, {
      method: "POST",
      body: JSON.stringify(data)
    });
    state.selectedVersionId = result.id;
    await loadVersions();
    toast("版本已创建");
    event.target.reset();
  };

  $("#nodeForm").onsubmit = async (event) => {
    event.preventDefault();
    requireVersion();
    const data = formData(event.target);
    const isAggregate = data.nodeType === "aggregate";
    await api(`/api/rule-versions/${state.selectedVersionId}/nodes`, {
      method: "POST",
      body: JSON.stringify({
        parentId: data.parentId || null,
        nodeType: data.nodeType,
        code: data.code,
        name: data.name,
        maxScore: isAggregate ? data.maxScore || null : null,
        aggregationType: isAggregate ? data.aggregationType || null : null,
        isApplyEntry: data.nodeType === "item",
        sortOrder: Number(data.sortOrder || 0),
        description: data.description
      })
    });
    await loadTree();
    toast("规则节点已添加");
    event.target.reset();
    syncNodeTypeControls();
  };

  const nodeTypeSelect = $("#nodeForm [name='nodeType']");
  const applyEntryCheckbox = $("#nodeForm [name='isApplyEntry']");
  const maxScoreInput = $("#nodeForm [name='maxScore']");
  const aggregationTypeSelect = $("#nodeForm [name='aggregationType']");
  const aggregateMaxScoreField = $("#aggregateMaxScoreField");
  const aggregateTypeField = $("#aggregateTypeField");
  const syncNodeTypeControls = () => {
    // 字段 max_score 和 aggregation_type 只描述汇总节点；规则项分值在“节点配置”页单独维护。
    const isItem = nodeTypeSelect.value === "item";
    applyEntryCheckbox.checked = isItem;
    applyEntryCheckbox.disabled = true;
    aggregateMaxScoreField.hidden = isItem;
    aggregateTypeField.hidden = isItem;
    maxScoreInput.disabled = isItem;
    aggregationTypeSelect.disabled = isItem;
    if (isItem) {
      maxScoreInput.value = "";
      aggregationTypeSelect.value = "";
    }
  };
  nodeTypeSelect.onchange = syncNodeTypeControls;
  syncNodeTypeControls();

  $("#deleteNodeBtn").onclick = async () => {
    try {
      requireNode();
      const node = state.selectedNode;
      const scope = node.children?.length ? "及其全部下级节点" : "";
      if (!confirm(`确认删除“${node.name}”${scope}？已有申报或核算引用时系统会拒绝删除。`)) return;
      const result = await api(`/api/rule-nodes/${node.id}`, { method: "DELETE" });
      state.selectedNode = null;
      await loadTree();
      toast(`已删除 ${result.deleted_node_count} 个节点`);
    } catch (error) {
      toast(error.message);
    }
  };

  $("#calcForm").onsubmit = async (event) => {
    event.preventDefault();
    requireNode();
    const data = formData(event.target);
    await api(`/api/rule-nodes/${state.selectedNode.id}/calculation-configs`, {
      method: "POST",
      body: JSON.stringify({
        configType: data.configType,
        formulaCode: data.formulaCode || null,
        roundingRule: data.roundingRule || null,
        configJson: parseJsonInput(data.configJson, {})
      })
    });
    await loadTree();
    toast("计分配置已添加");
  };

  $("#fieldForm").onsubmit = async (event) => {
    event.preventDefault();
    requireNode();
    const data = formData(event.target);
    await api(`/api/rule-nodes/${state.selectedNode.id}/form-fields`, {
      method: "POST",
      body: JSON.stringify({
        fieldKey: data.fieldKey,
        fieldLabel: data.fieldLabel,
        fieldType: data.fieldType,
        required: Boolean(data.required),
        optionsJson: parseJsonInput(data.optionsJson, null)
      })
    });
    await loadTree();
    toast("申报字段已添加");
    event.target.reset();
  };

  $("#materialForm").onsubmit = async (event) => {
    event.preventDefault();
    requireNode();
    const data = formData(event.target);
    await api(`/api/rule-nodes/${state.selectedNode.id}/materials`, {
      method: "POST",
      body: JSON.stringify({
        materialName: data.materialName,
        fileTypeLimit: data.fileTypeLimit,
        maxFileCount: Number(data.maxFileCount || 1),
        description: data.description
      })
    });
    await loadTree();
    toast("材料要求已添加");
    event.target.reset();
  };

  $("#auditForm").onsubmit = async (event) => {
    event.preventDefault();
    requireNode();
    const data = formData(event.target);
    await api(`/api/rule-nodes/${state.selectedNode.id}/audit-requirements`, {
      method: "POST",
      body: JSON.stringify({
        auditRole: data.auditRole,
        needSecondAudit: data.needSecondAudit === "1",
        auditInstruction: data.auditInstruction,
        rejectReasonTemplate: parseJsonInput(data.rejectReasonTemplate, null)
      })
    });
    await loadTree();
    toast("审核要求已添加");
    event.target.reset();
  };

  $("#scopeForm").onsubmit = async (event) => {
    event.preventDefault();
    requireNode();
    const data = formData(event.target);
    await api(`/api/rule-nodes/${state.selectedNode.id}/scopes`, {
      method: "POST",
      body: JSON.stringify(data)
    });
    await loadTree();
    toast("适用范围已添加");
    event.target.reset();
  };

  $("#groupRuleForm").onsubmit = async (event) => {
    event.preventDefault();
    requireNode();
    const data = formData(event.target);
    await api(`/api/rule-nodes/${state.selectedNode.id}/group-rules`, {
      method: "POST",
      body: JSON.stringify({
        distributionType: data.distributionType,
        configJson: parseJsonInput(data.configJson, {})
      })
    });
    await loadTree();
    toast("团体分配规则已添加");
  };

  $("#yearForm").onsubmit = async (event) => {
    event.preventDefault();
    const data = formData(event.target);
    await api("/api/academic-years", { method: "POST", body: JSON.stringify(data) });
    await loadYears();
    toast("学年已创建");
    event.target.reset();
  };

  $("#snapshotForm").onsubmit = async (event) => {
    event.preventDefault();
    requireVersion();
    const data = formData(event.target);
    if (!data.academicYearId) throw new Error("请先创建或选择学年");
    await api(`/api/academic-years/${data.academicYearId}/bind-snapshot`, {
      method: "POST",
      body: JSON.stringify({ ruleSetVersionId: state.selectedVersionId })
    });
    await loadYears();
    toast("学年快照已绑定");
  };

  $("#loadApplyBtn").onclick = async () => {
    state.selectedApplyYearId = selectedApplyYearId();
    state.applyStudentId = $("#applyStudentId").value || state.applyStudentId;
    state.selectedApplyApplication = null;
    await loadApplyWorkspace();
    toast("申报信息已刷新");
  };

  $("#applyYearSelect").onchange = async () => {
    state.selectedApplyYearId = selectedApplyYearId();
    state.selectedApplyEntry = null;
    state.selectedApplyApplication = null;
    await loadApplyWorkspace();
  };

  $("#applyStudentId").onchange = async () => {
    state.applyStudentId = $("#applyStudentId").value || "2026001";
    state.selectedApplyApplication = null;
    await loadApplyApplications();
  };

  $("#saveDraftBtn").onclick = () =>
    saveApplyDraft()
      .then(() => toast("申报草稿已保存"))
      .catch((error) => toast(error.message));

  $("#submitApplyBtn").onclick = () =>
    submitCurrentApplyApplication()
      .then(() => toast("申报已提交，等待审核"))
      .catch((error) => toast(error.message));

  $("#materialUploadForm").onsubmit = async (event) => {
    event.preventDefault();
    const app = state.selectedApplyApplication;
    if (!app || !["draft", "returned"].includes(app.status)) {
      throw new Error("请先保存草稿，且只能为草稿或退回记录上传材料");
    }
    const file = $("#materialFileInput").files?.[0];
    if (!file) throw new Error("请选择要上传的材料文件");
    const contentBase64 = await fileToBase64(file);
    const data = await api(`/api/apply/applications/${app.id}/attachments`, {
      method: "POST",
      body: JSON.stringify({
        studentId: currentApplyStudentId(),
        materialRequirementId: $("#materialRequirementSelect").value || null,
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
        fileSize: file.size,
        contentBase64
      })
    });
    state.selectedApplyApplication = data.detail;
    await loadApplyApplications();
    state.selectedApplyApplication = data.detail;
    $("#materialFileInput").value = "";
    renderApply();
    toast("证明材料已上传");
  };

  $("#seedAuditBtn").onclick = async () => {
    const data = await api("/api/dev/seed-audit-calculation", { method: "POST", body: "{}" });
    await loadAuditApplications();
    toast(`已生成 ${data.applicationIds.length} 条申报样例`);
  };

  $("#loadAuditBtn").onclick = async () => {
    await loadAuditApplications();
    toast("审核列表已刷新");
  };

  $("#auditStatusFilter").onchange = async () => {
    state.selectedAuditApplication = null;
    await loadAuditApplications();
  };

  async function auditSelected(action, comment) {
    if (!state.selectedAuditApplication) throw new Error("请先选择申报记录");
    const result = await api(`/api/audit/applications/${state.selectedAuditApplication.id}/actions`, {
      method: "POST",
      body: JSON.stringify({
        action,
        auditRole: state.currentUser?.role === "class_committee" ? "class_committee" : "college_admin",
        auditorId: state.currentUser?.id || 1,
        comment
      })
    });
    const status = $("#auditStatusFilter").value;
    await loadAuditApplications();
    if (status !== "all") state.selectedAuditApplication = null;
    if (result.status === "approved") {
      toast(`审核动作已完成：申报已通过${result.auto_calculation ? "，已自动触发核算" : ""}`);
      return;
    }
    toast("审核动作已完成");
  }

  $("#approveBtn").onclick = () => auditSelected("approve", "审核通过").catch((error) => toast(error.message));
  $("#returnBtn").onclick = () => auditSelected("return", "请补充或修正证明材料").catch((error) => toast(error.message));
  $("#rejectBtn").onclick = () => auditSelected("reject", "材料不符合规则要求").catch((error) => toast(error.message));

  $("#runCalcBtn").onclick = async () => {
    const result = await api("/api/calculation/run", {
      method: "POST",
      body: JSON.stringify({ batchType: "formal", triggerReason: "manual-ui" })
    });
    await loadCalcBatches();
    state.selectedCalcBatchId = result.batchId;
    await loadCalcResults(result.batchId);
    toast(`核算完成：${result.calculatedStudents} 名学生`);
  };

  $("#loadCalcBtn").onclick = async () => {
    await loadCalcBatches();
    toast("核算批次已刷新");
  };
}

async function wireResultAndSystemEvents() {
  $("#loadResultBtn").onclick = async () => {
    await loadResultWorkspace();
    toast("结果已刷新");
  };
  $("#resultYearSelect").onchange = () => loadResultWorkspace().catch((error) => toast(error.message));
  $("#loadStatsBtn").onclick = async () => {
    await loadClassStats();
    toast("统计已刷新");
  };
  $("#exportResultBtn").onclick = async () => {
    const yearId = selectedResultYearId();
    const payload = await api(`/api/results/export${yearId ? `?academicYearId=${encodeURIComponent(yearId)}` : ""}`);
    downloadBase64File(payload);
    toast("结果已导出");
  };
  async function startPublicity(role) {
    const yearId = selectedResultYearId();
    if (!yearId) throw new Error("请先选择学年");
    await api("/api/results/publicity/start", {
      method: "POST",
      body: JSON.stringify({ academicYearId: Number(yearId), initiatorRole: role, createdBy: role === "college_admin" ? 2 : 1 })
    });
    await loadResultWorkspace();
    toast(role === "college_admin" ? "学院管理员已发起公示" : "班委已发起公示");
  }
  $("#startClassPublicityBtn").onclick = () => startPublicity("class_committee").catch((error) => toast(error.message));
  $("#startCollegePublicityBtn").onclick = () => startPublicity("college_admin").catch((error) => toast(error.message));
  $("#endPublicityBtn").onclick = async () => {
    const active = state.publicityBatches.find((item) => item.status === "publicizing") || state.publicityStatus;
    if (!active?.id) throw new Error("当前没有正在公示的批次");
    await api(`/api/results/publicity/${active.id}/end`, { method: "POST", body: "{}" });
    await loadResultWorkspace();
    toast("公示已结束");
  };

  document.querySelectorAll(".sub-tab").forEach((btn) => {
    btn.onclick = async () => {
      state.systemTab = btn.dataset.systemTab;
      renderSystem();
      if (state.systemTab === "students") await loadStudents();
      if (state.systemTab === "users") await loadUsers();
      if (state.systemTab === "logs") await loadOperationLogs();
    };
  });

  $("#loadStudentsBtn").onclick = () => loadStudents().catch((error) => toast(error.message));
  $("#studentForm").onsubmit = async (event) => {
    event.preventDefault();
    const data = formData(event.target);
    const payload = {
      studentNo: data.studentNo,
      name: data.name,
      grade: data.grade,
      major: data.major,
      className: data.className,
      status: data.status,
      phone: data.phone,
      email: data.email,
      studentType: data.studentType
    };
    const saved = data.id
      ? await api(`/api/admin/students/${data.id}`, { method: "PUT", body: JSON.stringify(payload) })
      : await api("/api/admin/students", { method: "POST", body: JSON.stringify(payload) });
    state.selectedStudent = saved.id ? await api(`/api/admin/students/${saved.id}`) : saved;
    await loadStudents();
    toast("学生信息已保存");
  };
  $("#downloadStudentTemplateBtn").onclick = async () => downloadBase64File(await api("/api/admin/students/template"));
  $("#studentImportInput").onchange = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const contentBase64 = await fileToBase64(file);
    const result = await api("/api/admin/students/import", { method: "POST", body: JSON.stringify({ contentBase64 }) });
    event.target.value = "";
    await loadStudents();
    toast(`学生导入完成：成功 ${result.success}，失败 ${result.failed}`);
  };

  $("#loadUsersBtn").onclick = () => loadUsers().catch((error) => toast(error.message));
  $("#userForm").onsubmit = async (event) => {
    event.preventDefault();
    const data = formData(event.target);
    const payload = {
      username: data.username,
      displayName: data.displayName,
      password: data.password,
      role: data.role,
      status: data.status,
      email: data.email,
      relatedStudentId: data.relatedStudentId || null
    };
    const saved = data.id
      ? await api(`/api/admin/users/${data.id}`, { method: "PUT", body: JSON.stringify(payload) })
      : await api("/api/admin/users", { method: "POST", body: JSON.stringify(payload) });
    await loadUsers();
    state.selectedUser = state.users.find((item) => item.id === (saved.id || Number(data.id))) || null;
    toast("用户信息已保存");
  };
  $("#downloadUserTemplateBtn").onclick = async () => downloadBase64File(await api("/api/admin/users/template"));
  $("#userImportInput").onchange = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const contentBase64 = await fileToBase64(file);
    const result = await api("/api/admin/users/import", { method: "POST", body: JSON.stringify({ contentBase64 }) });
    event.target.value = "";
    await loadUsers();
    toast(`用户导入完成：成功 ${result.success}，失败 ${result.failed}`);
  };
  $("#resetUserPasswordBtn").onclick = async () => {
    const id = $("#userForm").elements.id.value;
    if (!id) throw new Error("请先选择用户");
    await api(`/api/admin/users/${id}/password`, {
      method: "POST",
      body: JSON.stringify({ password: $("#userForm").elements.password.value || "123456" })
    });
    toast("密码已重置");
  };
  $("#loadLogsBtn").onclick = () => loadOperationLogs().catch((error) => toast(error.message));
  $("#logModuleFilter").onchange = () => loadOperationLogs().catch((error) => toast(error.message));
}

async function refresh() {
  await loadHealth();
  await loadRuleSets();
  await loadYears();
  if (state.activeTab === "apply") await loadApplyWorkspace();
  if (state.activeTab === "audit") await loadAuditApplications();
  if (state.activeTab === "import") await loadImportWorkspace();
  if (state.activeTab === "calc") await loadCalcBatches();
  if (state.activeTab === "result") await loadResultWorkspace();
  if (state.activeTab === "system") await Promise.all([loadStudents(), loadUsers(), loadOperationLogs()]);
}

async function wireAuthAndImportEvents() {
  const roleAccounts = {
    student: "student001",
    class_committee: "committee001",
    college_admin: "admin001",
    super_admin: "rootadmin"
  };
  document.querySelectorAll("#loginForm input[name='role']").forEach((input) => {
    input.onchange = () => {
      $("#loginForm").elements.username.value = roleAccounts[input.value];
    };
  });

  $("#loginForm").onsubmit = async (event) => {
    event.preventDefault();
    try {
      const data = formData(event.target);
      const session = await api("/api/auth/login", { method: "POST", body: JSON.stringify(data) });
      state.authToken = session.token;
      localStorage.setItem("zongce_auth_token", session.token);
      applyRoleWorkspace(session.user);
      await refresh();
      toast("登录成功");
    } catch (error) {
      toast(error.message);
    }
  };

  $("#logoutBtn").onclick = async () => {
    try {
      await api("/api/auth/logout", { method: "POST", body: "{}" });
    } finally {
      clearSession();
    }
  };

  $("#importYearSelect").onchange = () => loadImportWorkspace().catch((error) => toast(error.message));
  $("#loadImportHistoryBtn").onclick = () => loadImportHistory().catch((error) => toast(error.message));
  $("#downloadImportTemplateBtn").onclick = async () => {
    const scope = state.currentUser?.role === "class_committee" ? "committee" : "college";
    downloadBase64File(await api(`/api/imports/template?scope=${scope}`));
  };
  $("#uploadScoresBtn").onclick = async () => {
    const file = $("#scoreImportInput").files?.[0];
    const academicYearId = Number($("#importYearSelect").value);
    const ruleNodeId = Number($("#importRuleNodeSelect").value);
    if (!file) throw new Error("请先选择 xlsx 文件");
    if (!academicYearId || !ruleNodeId) throw new Error("请选择学年和目标规则项");
    const scope = state.currentUser?.role === "class_committee" ? "committee" : "college";
    const result = await api(`/api/imports/${scope}`, {
      method: "POST",
      body: JSON.stringify({
        academicYearId,
        ruleNodeId,
        fileName: file.name,
        contentBase64: await fileToBase64(file)
      })
    });
    $("#importResult").innerHTML = `<strong>上传批次 #${result.batchId}</strong><br>成功 ${result.success} 行，失败 ${result.failed} 行${result.errors?.length ? `<br>${result.errors.map((item) => `第 ${item.row} 行：${escapeHtml(item.message)}`).join("<br>")}` : ""}`;
    $("#scoreImportInput").value = "";
    await loadImportHistory();
    toast(`上传完成，成功 ${result.success} 行`);
  };
}

async function startApplication() {
  wireEvents();
  wireResultAndSystemEvents();
  await wireAuthAndImportEvents();
  if (!state.authToken) return;
  try {
    const user = await api("/api/auth/me");
    applyRoleWorkspace(user);
    await refresh();
  } catch {
    clearSession();
  }
}

window.addEventListener("error", (event) => {
  toast(event.error?.message || event.message);
});

window.addEventListener("unhandledrejection", (event) => {
  toast(event.reason?.message || "请求失败");
});

startApplication();
