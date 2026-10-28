// A resident Vibe reads the Convertigo MCP tool list once, when its process starts. The Assistant names what the MCP
// lists for the user (feedback:on once they agreed to send feedback, which lists the report tool): when it changes, the
// process restarts on the same ACP session.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const vibe = fs.readFileSync(path.join(root, 'js/agent_bridge_vibe.js'), 'utf8');
const sequence = fs.readFileSync(path.join(root, '_c8oProject/sequences/agent_vibe_start.yaml'), 'utf8');

test('agent_vibe_start passes the catalog key to vibeStart', () => {
  assert.match(sequence, /mcpCatalogKey: typeof mcpCatalogKey === "undefined" \? "" : mcpCatalogKey,\n/);
  assert.match(sequence, /^↓mcpCatalogKey \[variables\.RequestableVariable-\d+\]: $/m);
});

test('a changed catalog key restarts Vibe on the same session; a process started without a key counts as feedback:off', () => {
  assert.match(vibe, /var catalogChanged = requestedCatalogKey\.length > 0 && \(trim\(existing\.mcpCatalogKey\) \|\| "feedback:off"\) !== requestedCatalogKey;/);
  const branch = vibe.slice(vibe.indexOf('} else if (catalogChanged) {'), vibe.indexOf('} else if (revealChanged) {'));
  assert.match(branch, /options\.sessionId = trim\(existing\.sessionId\);/);
  assert.match(branch, /reason: "mcp_catalog_changed"/);
  assert.match(branch, /stopEntry\(existing, true\);\n\s+existing = null;/);
  assert.match(vibe, /entry\.mcpCatalogKey = trim\(options\.mcpCatalogKey\);/);
});
