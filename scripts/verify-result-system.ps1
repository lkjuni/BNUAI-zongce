$ErrorActionPreference = "Stop"

$node = "C:\Users\33267\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if (!(Test-Path -LiteralPath $node)) {
  $node = "node"
}

$cwd = (Resolve-Path ".").Path
$port = "5178"
$job = Start-Job -ScriptBlock {
  param($nodePath, $workDir, $serverPort)
  Set-Location $workDir
  $env:PORT = $serverPort
  $env:HOST = "0.0.0.0"
  & $nodePath "src/server.js" 2>&1
} -ArgumentList $node, $cwd, $port

Start-Sleep -Seconds 3

try {
@'
const base = 'http://127.0.0.1:5178';

async function api(path, options = {}) {
  const res = await fetch(base + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const body = await res.json();
  if (!res.ok || body.code >= 400) throw new Error(`${body.message}: ${JSON.stringify(body.details || {})}`);
  return body.data;
}

async function ensureCalculation() {
  let batches = await api('/api/calculation/batches');
  if (batches.some(item => item.status === 'succeeded' && Number(item.result_count || 0) > 0)) return batches[0];
  await api('/api/dev/seed-audit-calculation', { method: 'POST', body: '{}' });
  const pending = await api('/api/audit/applications?status=submitted');
  for (const app of pending.slice(0, 3)) {
    await api(`/api/audit/applications/${app.id}/actions`, {
      method: 'POST',
      body: JSON.stringify({ action: 'approve', auditRole: 'college_admin', comment: 'verify result system' })
    });
  }
  batches = await api('/api/calculation/batches');
  return batches[0];
}

const health = await api('/api/health');
const studentNo = `99${Date.now().toString().slice(-8)}`;
const student = await api('/api/admin/students', {
  method: 'POST',
  body: JSON.stringify({
    studentNo,
    name: 'Verify Student',
    grade: '2026',
    major: 'AI',
    className: 'AI-2601',
    status: 'active'
  })
});
const studentDetail = await api(`/api/admin/students/${student.id}`);
const user = await api('/api/admin/users', {
  method: 'POST',
  body: JSON.stringify({
    username: `user_${studentNo}`,
    displayName: 'Verify User',
    password: '123456',
    role: 'class_committee',
    status: 'active'
  })
});
await api(`/api/admin/users/${user.id}/password`, { method: 'POST', body: JSON.stringify({ password: '654321' }) });
const studentTemplate = await api('/api/admin/students/template');
const userTemplate = await api('/api/admin/users/template');
const studentImport = await api('/api/admin/students/import', {
  method: 'POST',
  body: JSON.stringify({ contentBase64: studentTemplate.contentBase64 })
});
const userImport = await api('/api/admin/users/import', {
  method: 'POST',
  body: JSON.stringify({ contentBase64: userTemplate.contentBase64 })
});
const batch = await ensureCalculation();
const latest = await api('/api/results/latest');
const stats = await api('/api/results/statistics/classes');
const exported = await api('/api/results/export');

let publicity = null;
let ended = null;
try {
  publicity = await api('/api/results/publicity/start', {
    method: 'POST',
    body: JSON.stringify({ academicYearId: latest.batch.academic_year_id, batchId: latest.batch.id, initiatorRole: 'college_admin' })
  });
  ended = await api(`/api/results/publicity/${publicity.id}/end`, { method: 'POST', body: '{}' });
} catch (error) {
  const status = await api(`/api/results/publicity/status?academicYearId=${latest.batch.academic_year_id}`);
  if (status?.id && status.status === 'publicizing') {
    ended = await api(`/api/results/publicity/${status.id}/end`, { method: 'POST', body: '{}' });
  } else {
    throw error;
  }
}

const logs = await api('/api/admin/operation-logs');
const summary = {
  health,
  tableCount: health.table_count,
  studentCreated: Boolean(studentDetail.id),
  userCreated: Boolean(user.id),
  studentTemplateBytes: atob(studentTemplate.contentBase64).length,
  userTemplateBytes: atob(userTemplate.contentBase64).length,
  studentImportSuccess: studentImport.success,
  userImportSuccess: userImport.success,
  latestBatchId: latest.batch.id || batch.id,
  resultCount: latest.rows.length,
  classStatCount: stats.rows.length,
  exportBytes: atob(exported.contentBase64).length,
  publicityEnded: ended?.status === 'closed',
  logCount: logs.length
};

if (!summary.studentCreated || !summary.userCreated) throw new Error('system management create failed');
if (!summary.studentImportSuccess || !summary.userImportSuccess) throw new Error('xlsx import failed');
if (!summary.resultCount) throw new Error('result query returned no rows');
if (!summary.exportBytes) throw new Error('export file is empty');
if (!summary.publicityEnded) throw new Error('publicity was not closed');
console.log(JSON.stringify(summary, null, 2));
'@ | & $node --input-type=module -
} finally {
  Stop-Job $job -ErrorAction SilentlyContinue
  Receive-Job $job -ErrorAction SilentlyContinue | Select-Object -First 30
  Remove-Job $job -Force -ErrorAction SilentlyContinue
}
