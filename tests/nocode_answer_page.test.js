// MCP 0.3.0-beta.34 bounds every tool answer under ~14,000 characters (indented JSON, as Vibe weighs a script return):
// a longer one comes as partialAnswer pages read with answer-page. The No Code instruction listed the only Convertigo
// tools a No Code agent may call; answer-page must be among them, or the agent cannot read the rest of a long answer.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('the No Code agent may read the next pages of a long answer with answer-page', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'agent_bridge_common.js'), 'utf8');
  assert.match(source, /nocode-report-create when it is listed, and answer-page for the next pages of a long answer \(partialAnswer\)\. A No Code session has no log-view and no other Convertigo tool\./);
});
