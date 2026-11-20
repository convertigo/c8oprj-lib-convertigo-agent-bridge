// An internal call names its Convertigo context. A name built from the clock is shared by two calls made in the same
// millisecond in one HTTP session: the second waits on the first's context lock, and a long first call makes the agent's
// MCP call time out. Every internal context name is unique.
// node --test tests/internal_context_names.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function files(dir, pattern) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return files(full, pattern);
    return pattern.test(entry.name) ? [full] : [];
  });
}

test('no internal context is named after the clock', () => {
  const sources = files('js', /\.js$/).concat(files('_c8oProject', /\.yaml$/));
  const offenders = [];
  for (const file of sources) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      if (/__context/.test(line) && /now\(\)|currentTimeMillis|nanoTime|new Date|Date\.now/.test(line)) {
        offenders.push(file + ':' + (index + 1) + ': ' + line.trim());
      }
    });
  }
  assert.deepEqual(offenders, []);
});

test('the bridge names each internal call with a UUID', () => {
  const source = fs.readFileSync('js/agent_bridge_common.js', 'utf8');
  assert.match(source, /params\.put\("__context", "agentBridge_" \+ String\(UUID\.randomUUID\(\)\)\);/);
});
