$ErrorActionPreference = "Stop"

$node = "C:\Users\33267\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if (!(Test-Path -LiteralPath $node)) {
  $node = "node"
}

$cwd = (Resolve-Path ".").Path
$port = "5174"
$job = Start-Job -ScriptBlock {
  param($nodePath, $workDir, $serverPort)
  Set-Location $workDir
  $env:PORT = $serverPort
  & $nodePath "src/server.js" 2>&1
} -ArgumentList $node, $cwd, $port

Start-Sleep -Seconds 3

try {
@'
const base = 'http://127.0.0.1:5174';

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

const health = await api('/api/health');
const defaultSeed = await api('/api/dev/seed', {
  method: 'POST',
  body: '{}'
});
const seed = await api('/api/dev/seed-audit-calculation', {
  method: 'POST',
  body: '{}'
});

const pending = await api('/api/audit/applications?status=submitted');
const targetIds = seed.applicationIds;
const approvals = [];

for (const id of targetIds) {
  approvals.push(await api(`/api/audit/applications/${id}/actions`, {
    method: 'POST',
    body: JSON.stringify({
      action: 'approve',
      auditRole: 'college_admin',
      comment: 'verified'
    })
  }));
}

const approved = await api('/api/audit/applications?status=approved');
const calc = approvals.at(-1)?.auto_calculation;
if (!calc) {
  throw new Error('auto calculation was not triggered after approval');
}

const results = await api(`/api/calculation/batches/${calc.batchId}/results`);
const detail = results[0]
  ? await api(`/api/calculation/batches/${calc.batchId}/students/${results[0].student_id}`)
  : null;

const years = await api('/api/academic-years');
const year = years.find(row => row.id === seed.academicYearId);
const snapshotChange = await api(`/api/academic-years/${seed.academicYearId}/bind-snapshot`, {
  method: 'POST',
  body: JSON.stringify({ ruleSetVersionId: year.rule_set_version_id })
});
if (!snapshotChange.auto_calculation) {
  throw new Error('auto calculation was not triggered after snapshot change');
}

const summary = {
  health,
  defaultSeed,
  seed,
  pendingCountAfterSeed: pending.filter(row => targetIds.includes(row.id)).length,
  approvedSeedCount: approved.filter(row => targetIds.includes(row.id)).length,
  autoTriggerCount: approvals.filter(row => row.auto_calculation).length,
  snapshotAutoCalculation: snapshotChange.auto_calculation,
  calc,
  resultCount: results.length,
  topResult: results[0] || null,
  detailItemCount: detail?.items?.length || 0,
  detailNodeCount: detail?.nodes?.length || 0,
  warningCount: detail?.warnings?.length || 0,
  errorCount: detail?.errors?.length || 0
};

console.log(JSON.stringify(summary, null, 2));
'@ | & $node --input-type=module -
} finally {
  Stop-Job $job -ErrorAction SilentlyContinue
  Receive-Job $job -ErrorAction SilentlyContinue | Select-Object -First 20
  Remove-Job $job -Force -ErrorAction SilentlyContinue
}
