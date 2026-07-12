$ErrorActionPreference = "Stop"

. "$PSScriptRoot\common.ps1"

@'
const base = "http://127.0.0.1:5173";

async function request(path, options = {}) {
  const response = await fetch(base + path, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  const body = await response.json();
  return { response, body };
}

async function api(path, options = {}) {
  const { response, body } = await request(path, options);
  if (!response.ok || body.code >= 400) throw new Error(body.message || JSON.stringify(body));
  return body.data;
}

async function expectRejected(name, path, payload) {
  const { response, body } = await request(path, {
    method: "POST",
    body: JSON.stringify(payload)
  });
  if (response.ok || body.code < 400) throw new Error(`${name} was not rejected`);
  return { name, status: response.status, message: body.message };
}

function flatten(nodes, result = []) {
  for (const node of nodes) {
    result.push(node);
    flatten(node.children || [], result);
  }
  return result;
}

let ruleSetId = null;
try {
  const suffix = Date.now();
  const ruleSet = await api("/api/rule-sets", {
    method: "POST",
    body: JSON.stringify({ name: `rule-node-model-${suffix}`, description: "automated regression test" })
  });
  ruleSetId = ruleSet.id;

  const version = await api(`/api/rule-sets/${ruleSetId}/versions`, {
    method: "POST",
    body: JSON.stringify({ versionNo: `verify-${suffix}`, versionName: "node model verification" })
  });
  const nodePath = `/api/rule-versions/${version.id}/nodes`;

  const root = await api(nodePath, {
    method: "POST",
    body: JSON.stringify({ nodeType: "aggregate", code: "root", name: "Total score", aggregationType: "sum" })
  });

  const rejected = [];
  rejected.push(await expectRejected("duplicate root", nodePath, {
    nodeType: "module",
    code: "second-root",
    name: "Second root",
    aggregationType: "sum"
  }));
  rejected.push(await expectRejected("item as root", nodePath, {
    nodeType: "item",
    code: "root-item",
    name: "Invalid root item"
  }));
  rejected.push(await expectRejected("aggregate as apply entry", nodePath, {
    parentId: root.id,
    nodeType: "aggregate",
    code: "apply-aggregate",
    name: "Invalid apply aggregate",
    isApplyEntry: true
  }));

  const aggregate = await api(nodePath, {
    method: "POST",
    body: JSON.stringify({
      parentId: root.id,
      nodeType: "aggregate",
      code: "innovation",
      name: "Academic innovation",
      aggregationType: "cap",
      maxScore: 7
    })
  });
  const item = await api(nodePath, {
    method: "POST",
    body: JSON.stringify({
      parentId: aggregate.id,
      nodeType: "item",
      code: "paper",
      name: "Paper result",
      isApplyEntry: true
    })
  });
  rejected.push(await expectRejected("item as parent", nodePath, {
    parentId: item.id,
    nodeType: "item",
    code: "child-of-item",
    name: "Invalid child of item"
  }));

  const deleted = await api(`/api/rule-nodes/${aggregate.id}`, { method: "DELETE" });
  if (deleted.deleted_node_count !== 2) throw new Error(`Unexpected deleted subtree size: ${deleted.deleted_node_count}`);

  const tree = await api(`/api/rule-versions/${version.id}/tree`);
  const nodes = flatten(tree);
  const unexpectedTypes = nodes.filter((node) => !["aggregate", "item"].includes(node.node_type));
  if (tree.length !== 1) throw new Error(`Invalid root count: ${tree.length}`);
  if (unexpectedTypes.length) throw new Error(`Legacy node types remain: ${unexpectedTypes.map((node) => node.node_type).join(",")}`);

  console.log(JSON.stringify({
    passed: true,
    rootCount: tree.length,
    deletedNodeCount: deleted.deleted_node_count,
    nodeTypes: [...new Set(nodes.map((node) => node.node_type))].sort(),
    rejected
  }, null, 2));
} finally {
  if (ruleSetId) {
    await api(`/api/rule-sets/${ruleSetId}`, { method: "DELETE" });
  }
}
'@ | & $NodeExe --input-type=module -
