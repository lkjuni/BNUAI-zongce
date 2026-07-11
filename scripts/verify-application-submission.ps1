$ErrorActionPreference = "Stop"

$node = "C:\Users\33267\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if (!(Test-Path -LiteralPath $node)) {
  $node = "node"
}

$cwd = (Resolve-Path ".").Path
$port = "5176"
$job = Start-Job -ScriptBlock {
  param($nodePath, $workDir, $serverPort)
  Set-Location $workDir
  $env:PORT = $serverPort
  & $nodePath "src/server.js" 2>&1
} -ArgumentList $node, $cwd, $port

Start-Sleep -Seconds 3

try {
@'
const base = 'http://127.0.0.1:5176';

async function api(path, options = {}) {
  const res = await fetch(base + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const body = await res.json();
  if (!res.ok || body.code >= 400) {
    throw new Error(`${body.message}: ${JSON.stringify(body.details || {})}`);
  }
  return body.data;
}

function parseMaybeJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function optionValues(options) {
  const parsed = parseMaybeJson(options, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.map(item => {
    if (item && typeof item === 'object') return item.value ?? item.name ?? item.label;
    return item;
  });
}

async function ensureApplyEntries() {
  let years = await api('/api/academic-years');
  let year = years.find(row => row.current_snapshot_id);
  if (!year) {
    const seed = await api('/api/dev/seed', { method: 'POST', body: '{}' });
    await api(`/api/academic-years/${seed.academicYearId}/bind-snapshot`, {
      method: 'POST',
      body: JSON.stringify({ ruleSetVersionId: seed.versionId })
    });
    years = await api('/api/academic-years');
    year = years.find(row => row.id === seed.academicYearId);
  }

  let applyData = await api(`/api/apply/entries?academicYearId=${year.id}`);
  if (!applyData.entries.length) {
    const seed = await api('/api/dev/seed', { method: 'POST', body: '{}' });
    await api(`/api/academic-years/${seed.academicYearId}/bind-snapshot`, {
      method: 'POST',
      body: JSON.stringify({ ruleSetVersionId: seed.versionId })
    });
    year = (await api('/api/academic-years')).find(row => row.id === seed.academicYearId);
    applyData = await api(`/api/apply/entries?academicYearId=${year.id}`);
  }
  return { year, entries: applyData.entries };
}

function sampleValue(field) {
  if (field.field_type === 'select') {
    return optionValues(field.options_json)[0] ?? 'option-1';
  }
  if (field.field_type === 'multi_select') {
    const first = optionValues(field.options_json)[0];
    return first ? [first] : [];
  }
  if (field.field_type === 'number') {
    const validation = parseMaybeJson(field.validation_json, {});
    return Number(validation?.min ?? 1);
  }
  if (field.field_type === 'date') {
    return '2026-07-11';
  }
  return `${field.field_key}-verified`;
}

const health = await api('/api/health');
const { year, entries } = await ensureApplyEntries();
const entry = entries.find(item => (item.material_requirements || []).length) || entries[0];
if (!entry) throw new Error('No apply entry is available');

const studentId = 2099001 + Math.floor(Math.random() * 1000);
const fieldValues = {};
for (const field of entry.form_fields || []) {
  fieldValues[field.field_key] = sampleValue(field);
}

const batchesBefore = await api('/api/calculation/batches');
const draft = await api('/api/apply/applications', {
  method: 'POST',
  body: JSON.stringify({
    academicYearId: year.id,
    ruleNodeId: entry.id,
    studentId,
    title: `application-submission-verification-${studentId}`,
    fieldValues,
    members: [
      {
        member_student_id: studentId,
        member_name: `student-${studentId}`,
        role_name: 'owner',
        rank_no: 1,
        contribution_ratio: 1
      }
    ]
  })
});

const requiredMaterials = (entry.material_requirements || []).filter(item => item.required);
for (const material of requiredMaterials) {
  await api(`/api/apply/applications/${draft.id}/attachments`, {
    method: 'POST',
    body: JSON.stringify({
      studentId,
      materialRequirementId: material.id,
      fileName: `proof-${material.id}.pdf`,
      mimeType: 'application/pdf',
      contentBase64: Buffer.from(`proof for material ${material.id}`).toString('base64')
    })
  });
}

const submitted = await api(`/api/apply/applications/${draft.id}/submit`, {
  method: 'POST',
  body: JSON.stringify({ studentId })
});

const detail = await api(`/api/apply/applications/${draft.id}`);
const mine = await api(`/api/apply/applications?academicYearId=${year.id}&studentId=${studentId}`);
const auditSubmitted = await api('/api/audit/applications?status=submitted');
const batchesAfter = await api('/api/calculation/batches');

const summary = {
  health,
  academicYearId: year.id,
  entryCount: entries.length,
  selectedEntry: {
    id: entry.id,
    code: entry.code,
    name: entry.name,
    fieldCount: (entry.form_fields || []).length,
    materialCount: (entry.material_requirements || []).length,
    requiredMaterialCount: requiredMaterials.length
  },
  application: {
    id: draft.id,
    studentId,
    status: detail.status,
    fieldCount: detail.fields.length,
    attachmentCount: detail.attachments.filter(item => item.status === 'active').length,
    revisionCount: detail.revisions.length
  },
  submittedStatus: submitted.detail.status,
  visibleInStudentList: mine.some(item => item.id === draft.id),
  visibleInAuditQueue: auditSubmitted.some(item => item.id === draft.id),
  calculationTriggeredBySubmit: batchesAfter.length > batchesBefore.length
};

if (summary.application.status !== 'submitted') throw new Error('Application was not submitted');
if (summary.application.revisionCount !== 1) throw new Error('Submission revision was not created');
if (requiredMaterials.length && summary.application.attachmentCount < requiredMaterials.length) {
  throw new Error('Required material upload was not persisted');
}
if (!summary.visibleInAuditQueue) throw new Error('Submitted application is not visible in audit queue');
if (summary.calculationTriggeredBySubmit) throw new Error('Submission should not trigger calculation before approval');

const approval = await api(`/api/audit/applications/${draft.id}/actions`, {
  method: 'POST',
  body: JSON.stringify({
    action: 'approve',
    auditRole: 'college_admin',
    comment: 'application submission verification approval'
  })
});
if (!approval.auto_calculation) throw new Error('Approval should trigger automatic calculation');
summary.approvalAutoCalculation = approval.auto_calculation;

console.log(JSON.stringify(summary, null, 2));
'@ | & $node --input-type=module -
} finally {
  Stop-Job $job -ErrorAction SilentlyContinue
  Receive-Job $job -ErrorAction SilentlyContinue | Select-Object -First 20
  Remove-Job $job -Force -ErrorAction SilentlyContinue
}
