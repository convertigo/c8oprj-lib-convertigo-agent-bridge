// The Assistant calls agent_vibe_setup before every message, warm ones too. Its full check ran detectRuntime twice, each
// launching vibe-acp --version (3.3 to 4.6 s on test-nocode): 7 to 10 s per message. The sequence now takes
// startupPresenceOnly, which agent_vibe_start already used: the setup only checks that Vibe is installed.
// node --test tests/setup_presence.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const javaProxy = new Proxy(function(){},{get(_t,p){if(p===Symbol.toPrimitive)return ()=>'';return javaProxy;},apply(){return javaProxy;},construct(){return javaProxy;}});
global.Packages=javaProxy;global.context=javaProxy;global.C8O={agentBridge:{}};
for(const name of ['common','codex','claude','vibe'])vm.runInThisContext(fs.readFileSync(path.join(root,'js/agent_bridge_'+name+'.js'),'utf8'));
const sequence = fs.readFileSync(path.join(root, '_c8oProject/sequences/agent_vibe_setup.yaml'), 'utf8');

function setupWith(options) {
  const detections = [];
  const runtime = kind => () => {
    detections.push(kind);
    const command = name => ({ found: true, path: '/workspace/agents/vibe/.venv/bin/' + name, version: name + ' 3.0.1' });
    return { workspaceRoot: '/workspace', installDir: '/workspace/agents/vibe', venvDir: '/workspace/agents/vibe/.venv',
      vibeHome: '/workspace/agents/vibe/homes/u1', home: {}, vibe: command('vibe'), vibeAcp: command('vibe-acp'),
      config: { selected: { valid: true } } };
  };
  const fakes = {
    detectRuntime: runtime('full'),
    detectRuntimePresence: runtime('presence'),
    bootstrapVibeHome: () => ({ ok: true, copied: [], reused: [], refreshed: [] }),
    commandPathStartsWith: () => true,
    inspectVibeAuthentication: () => ({ configured: true }),
    installAgentSkills: () => ({ ok: true })
  };
  const saved = {};
  for (const [name, value] of Object.entries(fakes)) { saved[name] = global[name]; global[name] = value; }
  try {
    return { result: C8O.agentBridge.vibeSetup(options), detections };
  } finally {
    for (const [name, value] of Object.entries(saved)) global[name] = value;
  }
}

test('asked for presence only, the setup runs no Vibe command', () => {
  const { result, detections } = setupWith({ startupPresenceOnly: 'true' });
  assert.equal(result.status, 'ready');
  assert.deepEqual(detections, ['presence', 'presence']);
});

test('the full check stays the default, and an installation always gets it', () => {
  assert.deepEqual(setupWith({}).detections, ['full', 'full']);
  assert.deepEqual(setupWith({ startupPresenceOnly: 'false' }).detections, ['full', 'full']);
  assert.ok(setupWith({ startupPresenceOnly: 'true', install: 'true' }).detections.every(kind => kind === 'full'));
});

test('agent_vibe_setup takes startupPresenceOnly and hands it to vibeSetup', () => {
  assert.match(sequence, /startupPresenceOnly: typeof startupPresenceOnly === "undefined" \? false : startupPresenceOnly\n\s+\}\);'/);
  assert.match(sequence, /\n↓startupPresenceOnly \[variables\.RequestableVariable-\d+\]: \n  comment: [^\n]+\n  description: [^\n]+\n  schemaType: xsd:boolean/);
});
