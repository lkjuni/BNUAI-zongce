$ErrorActionPreference = "Stop"

. "$PSScriptRoot\common.ps1"

$cwd = (Resolve-Path ".").Path
$job = Start-Job -ScriptBlock {
  param($nodePath, $workDir)
  Set-Location $workDir
  & $nodePath "src/server.js" 2>&1
} -ArgumentList $NodeExe, $cwd

Start-Sleep -Seconds 3

try {
@'
const base = 'http://127.0.0.1:5173';

async function api(path, options = {}) {
  const res = await fetch(base + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const body = await res.json();
  if (!res.ok || body.code >= 400) {
    throw new Error(body.message || JSON.stringify(body));
  }
  return body.data;
}

function flatten(nodes, out = []) {
  for (const node of nodes) {
    out.push(node);
    flatten(node.children || [], out);
  }
  return out;
}

const health = await api('/api/health');
const seed = await api('/api/dev/seed', { method: 'POST', body: '{}' });
let tree = await api(`/api/rule-versions/${seed.versionId}/tree`);
let flat = flatten(tree);

const sports = flat.find(node => node.code === 'student_work.activity.sports');
if (!sports) {
  throw new Error('未找到文体比赛类节点');
}

const added = await api(`/api/rule-versions/${seed.versionId}/nodes`, {
  method: 'POST',
  body: JSON.stringify({
    parentId: sports.id,
    nodeType: 'item',
    code: 'student_work.activity.sports.demo_extra',
    name: 'Sports demo extra item',
    maxScore: 1,
    aggregationType: 'sum',
    isApplyEntry: true,
    sortOrder: 99,
    description: 'End-to-end verification rule item'
  })
});

await api(`/api/rule-nodes/${added.id}/calculation-configs`, {
  method: 'POST',
  body: JSON.stringify({
    configType: 'fixed',
    configJson: { score: 1 },
    roundingRule: 'none'
  })
});

await api(`/api/rule-nodes/${added.id}/form-fields`, {
  method: 'POST',
  body: JSON.stringify({
    fieldKey: 'event_name',
    fieldLabel: 'Event name',
    fieldType: 'text',
    required: true
  })
});

await api(`/api/rule-nodes/${added.id}/materials`, {
  method: 'POST',
  body: JSON.stringify({
    materialName: 'Event proof',
    fileTypeLimit: 'pdf,jpg,png',
    maxFileCount: 2,
    description: 'Verification material requirement'
  })
});

await api(`/api/rule-nodes/${added.id}/audit-requirements`, {
  method: 'POST',
  body: JSON.stringify({
    auditRole: 'class_committee',
    auditInstruction: 'Check event proof and participant list.',
    needSecondAudit: false,
    rejectReasonTemplate: ['Incomplete material']
  })
});

await api(`/api/rule-nodes/${added.id}/scopes`, {
  method: 'POST',
  body: JSON.stringify({
    scopeType: 'student_type',
    scopeValue: 'normal',
    includeOrExclude: 'include'
  })
});

await api(`/api/rule-nodes/${added.id}/group-rules`, {
  method: 'POST',
  body: JSON.stringify({
    distributionType: 'equal',
    configJson: { all_members_ratio: 1 }
  })
});

const snapshot = await api(`/api/academic-years/${seed.academicYearId}/bind-snapshot`, {
  method: 'POST',
  body: JSON.stringify({ ruleSetVersionId: seed.versionId })
});

tree = await api(`/api/rule-versions/${seed.versionId}/tree`);
flat = flatten(tree);

const summary = {
  health,
  seed,
  addedNodeId: added.id,
  snapshotId: snapshot.id,
  nodeCount: flat.length,
  applyEntryCount: flat.filter(node => node.is_apply_entry).length,
  formFieldCount: flat.reduce((sum, node) => sum + (node.form_fields || []).length, 0),
  materialCount: flat.reduce((sum, node) => sum + (node.material_requirements || []).length, 0),
  auditRequirementCount: flat.reduce((sum, node) => sum + (node.audit_requirements || []).length, 0),
  scopeCount: flat.reduce((sum, node) => sum + (node.scopes || []).length, 0),
  groupRuleCount: flat.reduce((sum, node) => sum + (node.group_distribution_rules || []).length, 0)
};

console.log(JSON.stringify(summary, null, 2));
'@ | & $NodeExe --input-type=module -
} finally {
  Stop-Job $job -ErrorAction SilentlyContinue
  Receive-Job $job -ErrorAction SilentlyContinue | Select-Object -First 20
  Remove-Job $job -Force -ErrorAction SilentlyContinue
}
