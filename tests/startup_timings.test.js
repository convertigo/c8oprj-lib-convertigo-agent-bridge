// A new No Code conversation took 14 to 25 s before its first prompt reached Vibe (test-nocode, the model answering in
// 2 s). vibeStart, vibePrompt and settings now write what each step takes, one JSON line per call, in
// agents/vibe/startup-timings.ndjson.
// node --test tests/startup_timings.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const javaProxy = new Proxy(function(){},{get(_t,p){if(p===Symbol.toPrimitive)return ()=>'';return javaProxy;},apply(){return javaProxy;},construct(){return javaProxy;}});
global.Packages=javaProxy;global.context=javaProxy;global.C8O={agentBridge:{}};
for(const name of ['common','codex','claude','vibe'])vm.runInThisContext(fs.readFileSync(path.join(root,'js/agent_bridge_'+name+'.js'),'utf8'));
const vibeSource = fs.readFileSync(path.join(root, 'js/agent_bridge_vibe.js'), 'utf8');
const commonSource = fs.readFileSync(path.join(root, 'js/agent_bridge_common.js'), 'utf8');

function written(run) {
  const lines = [];
  let clock = 1000;
  class FakeFile {
    constructor(parent, child) { this.p = child === undefined ? String(parent) : path.join(String(parent.p || parent), String(child)); }
    isFile() { return false; }
    toPath() { return this.p; }
  }
  const saved = {};
  const fakes = {
    File: FakeFile,
    ensureDirectory: () => {},
    now: () => clock,
    Files: { write: (file, bytes) => { lines.push({ file, text: String(bytes) }); } },
    StandardOpenOption: {},
    java: { lang: { String: function (text) { this.getBytes = () => text; } } }
  };
  for (const [name, value] of Object.entries(fakes)) { saved[name] = global[name]; global[name] = value; }
  try { run(ms => { clock += ms; }); } finally { for (const [name, value] of Object.entries(saved)) global[name] = value; }
  return lines;
}

test('a timed call writes one line with the time of each step and its total', () => {
  const lines = written(advance => {
    const timer = startupTimer('start', { handle: 'h1', conversationId: 'agent-1' });
    activeStartupTimer = timer;
    advance(1200); startupMark('setup');
    advance(300); startupMark('process/spawn');
    advance(9000); startupMark('acp/session-new');
    activeStartupTimer = null;
    advance(100);
    writeStartupTimings(timer, '/workspace', 'started');
  });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].file, '/workspace/agents/vibe/startup-timings.ndjson');
  const line = JSON.parse(lines[0].text);
  assert.equal(line.kind, 'start');
  assert.equal(line.outcome, 'started');
  assert.equal(line.totalMs, 10600);
  assert.equal(line.handle, 'h1');
  assert.equal(line.conversationId, 'agent-1');
  assert.deepEqual(line.steps, [{ step: 'setup', ms: 1200 }, { step: 'process/spawn', ms: 300 }, { step: 'acp/session-new', ms: 9000 }]);
});

test('a step outside a timed call writes nothing', () => {
  activeStartupTimer = null;
  assert.doesNotThrow(() => startupMark('setup'));
});

test('vibeStart and settings are timed around their steps; vibePrompt writes when a prompt arrives', () => {
  assert.match(vibeSource, /C8O\.agentBridge\.vibeStart = function \(options\) \{\n\s+var timer = startupTimer\("start"/);
  assert.match(vibeSource, /result = vibeStartSteps\(options\);/);
  assert.match(vibeSource, /writeStartupTimings\(startupTimer\("prompt", \{ handle: handle \}\), entry\.workspaceRoot, "received"\);/);
  assert.match(commonSource, /result = agentSettingsSteps\(options\);/);
  for (const step of ['existing', 'setup', 'env', 'sandbox', 'entry', 'acp/initialize', 'settings', 'configure', 'setup/detect', 'setup/config', 'setup/bootstrap', 'setup/skills']) {
    assert.ok(vibeSource.includes('startupMark("' + step + '")'), step);
  }
  for (const step of ['process/sweep', 'process/guard', 'process/spawn', 'settings/providers', 'settings/discover']) {
    assert.ok(commonSource.includes('startupMark("' + step + '")'), step);
  }
});
