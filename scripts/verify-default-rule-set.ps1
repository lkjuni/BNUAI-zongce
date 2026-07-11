$ErrorActionPreference = "Stop"

$node = "C:\Users\33267\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if (!(Test-Path -LiteralPath $node)) {
  $node = "node"
}

$cwd = (Resolve-Path ".").Path
$port = "5179"
$job = Start-Job -ScriptBlock {
  param($nodePath, $workDir, $serverPort)
  Set-Location $workDir
  $env:PORT = $serverPort
  $env:BIND_HOST = "0.0.0.0"
  & $nodePath "src/server.js" 2>&1
} -ArgumentList $node, $cwd, $port

Start-Sleep -Seconds 3

try {
@'
const base = 'http://127.0.0.1:5179';

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

function flattenTree(nodes, rows = []) {
  for (const node of nodes || []) {
    rows.push(node);
    flattenTree(node.children || [], rows);
  }
  return rows;
}

const seed = await api('/api/dev/seed', { method: 'POST', body: '{}' });
const tree = await api(`/api/rule-versions/${seed.versionId}/tree`);
const nodes = flattenTree(tree);
const byCode = new Map(nodes.map((node) => [node.code, node]));

const requiredCodes = [
  'innovation',
  'innovation.research.project.result',
  'innovation.research.paper.publication',
  'innovation.research.other.patent',
  'innovation.competition.professional.award',
  'innovation.competition.creative.award',
  'innovation.competition.teacher.award',
  'innovation.certification.csp',
  'student_work',
  'student_work.position.role',
  'student_work.activity.sports.award',
  'student_work.activity.college_event.participation',
  'student_work.activity.practice.result',
  'student_work.activity.party_class.record'
];

const missing = requiredCodes.filter((code) => !byCode.has(code));
if (missing.length) throw new Error(`Missing required default rule codes: ${missing.join(', ')}`);

const applyEntries = nodes.filter((node) => Number(node.is_apply_entry) === 1);
const formFieldCount = applyEntries.reduce((sum, node) => sum + (node.form_fields || []).length, 0);
const materialCount = applyEntries.reduce((sum, node) => sum + (node.material_requirements || []).length, 0);
const auditCount = applyEntries.reduce((sum, node) => sum + (node.audit_requirements || []).length, 0);
const calculationCount = nodes.reduce((sum, node) => sum + (node.calculation_configs || []).length, 0);

if (applyEntries.length < 10) throw new Error(`Expected at least 10 apply entries, got ${applyEntries.length}`);
if (formFieldCount < 15) throw new Error(`Expected enough form fields, got ${formFieldCount}`);
if (materialCount < 10) throw new Error(`Expected enough material requirements, got ${materialCount}`);
if (auditCount < 10) throw new Error(`Expected enough audit requirements, got ${auditCount}`);
if (calculationCount < 10) throw new Error(`Expected enough calculation configs, got ${calculationCount}`);

const yearDeletion = await api(`/api/academic-years/${seed.academicYearId}`, { method: 'DELETE' });
if (!yearDeletion.deleted) throw new Error(`Seed academic year should be deleted before business use: ${JSON.stringify(yearDeletion)}`);

const deletion = await api(`/api/rule-sets/${seed.ruleSetId}`, { method: 'DELETE' });
if (!deletion.deleted) throw new Error(`Seed rule set should be deleted before business use: ${JSON.stringify(deletion)}`);

console.log(JSON.stringify({
  ruleSetId: seed.ruleSetId,
  versionId: seed.versionId,
  academicYearId: seed.academicYearId,
  snapshotId: seed.snapshotId,
  nodeCount: nodes.length,
  applyEntryCount: applyEntries.length,
  formFieldCount,
  materialCount,
  auditCount,
  calculationConfigCount: calculationCount,
  yearDeletion,
  deletion
}, null, 2));
'@ | & $node --input-type=module -
} finally {
  Stop-Job $job -ErrorAction SilentlyContinue
  Receive-Job $job -ErrorAction SilentlyContinue | Select-Object -First 30
  Remove-Job $job -Force -ErrorAction SilentlyContinue
}
