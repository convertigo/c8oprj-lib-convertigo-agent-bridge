// A full settings read of a No Code user took 10 s on test-nocode (28/10) since Codex was installed there: each panel
// opening ran `npm --version` six times and the Playwright MCP three times, Codex being detected before and after its
// home was prepared, then again for Claude. A settings read now probes each command once, and its timings line says
// what each provider took.
// node --test tests/settings_probe_once.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const javaProxy = new Proxy(function(){},{get(_t,p){if(p===Symbol.toPrimitive)return ()=>'';return javaProxy;},apply(){return javaProxy;},construct(){return javaProxy;}});
global.Packages=javaProxy;global.context=javaProxy;global.C8O={agentBridge:{}};
for(const name of ['common','codex','claude','vibe'])vm.runInThisContext(fs.readFileSync(path.join(root,'js/agent_bridge_'+name+'.js'),'utf8'));

function withGlobals(fakes, run) {
  const saved = {};
  for (const [name, value] of Object.entries(fakes)) { saved[name] = global[name]; global[name] = value; }
  try { return run(); } finally { for (const [name, value] of Object.entries(saved)) global[name] = value; }
}

test('inside a settings read, a command is probed once; outside, every time', () => {
  const probes = [];
  withGlobals({ runCommand: args => { probes.push(args.join(' ')); return { ok: true, stdout: '10.9.2', stderr: '' }; } }, () => {
    activeProbeMemo = {};
    try {
      const first = firstWorkingCommand(['/node/bin/npm', 'npm'], ['--version']);
      const second = firstWorkingCommand(['/node/bin/npm', 'npm'], ['--version']);
      assert.equal(first.found, true);
      assert.equal(second, first, 'the same answer');
      firstWorkingCommand(['/node/bin/npx', 'npx'], ['--version']);
      firstWorkingCommand(['/node/bin/npm', 'npm'], ['--version'], '/extra/bin');
    } finally {
      activeProbeMemo = null;
    }
    assert.deepEqual(probes, ['/node/bin/npm --version', '/node/bin/npx --version', '/node/bin/npm --version']);
    firstWorkingCommand(['/node/bin/npm', 'npm'], ['--version']);
    firstWorkingCommand(['/node/bin/npm', 'npm'], ['--version']);
    assert.equal(probes.length, 5, 'an install or a start probes again');
  });
});

test('inside a settings read, the Playwright MCP is probed once per install directory', () => {
  const probes = [];
  withGlobals({ probeCodexPlaywrightRuntime: (options, installDir) => { probes.push(installDir); return { found: true, installDir }; } }, () => {
    activeProbeMemo = {};
    try {
      const codex = detectCodexPlaywrightRuntime({}, '/ws/agents/codex');
      assert.equal(detectCodexPlaywrightRuntime({}, '/ws/agents/codex'), codex);
      detectCodexPlaywrightRuntime({}, '/ws/agents/claude');
    } finally {
      activeProbeMemo = null;
    }
    detectCodexPlaywrightRuntime({}, '/ws/agents/codex');
    assert.deepEqual(probes, ['/ws/agents/codex', '/ws/agents/claude', '/ws/agents/codex']);
  });
});

test('a settings read probes in its own memo, gone once it answers, and times each provider', () => {
  let clock = 1000;
  const memos = [];
  const lines = [];
  const provider = (id, ms) => () => { memos.push(activeProbeMemo); clock += ms; return { id, ready: id === 'convertigo', status: id === 'convertigo' ? 'ready' : 'missing', models: [] }; };
  withGlobals({
    now: () => clock,
    optionsWithRequestFallbacks: options => options,
    hydrateProviderSettingsFromCache: (_root, provider) => provider, requireCachedProviderConfiguration: provider => provider,
    requireProviderAuthentication: provider => provider, readPersistentAgentPreferences: () => null, validatedAgentPreferences: () => null,
    cleanupAgentStorage: () => ({ status: 'skipped', removed: [], errors: [] }), windowsRuntimeDiagnostics: () => null,
    publicAgentCapabilityProfile: () => ({}), publicAgentCapabilityProfiles: () => [],
    vibeSettings: options => provider(options.vibeProfile === 'mistral' ? 'vibe' : 'convertigo', options.vibeProfile === 'mistral' ? 30 : 400)(),
    codexSettings: provider('codex', 6000),
    claudeSettings: provider('claude', 2500),
    writeStartupTimings: (timer, workspaceRoot, outcome) => lines.push({ fields: timer.fields, steps: timer.marks, outcome })
  }, () => {
    activeProbeMemo = null;
    C8O.agentBridge.settings({ workspaceRoot: '', userId: 'forms-user', runtimePresenceOnly: 'true' });
  });
  assert.equal(memos.length, 4);
  assert.ok(memos.every(memo => memo !== null && memo === memos[0]), 'one memo for the whole read');
  assert.equal(activeProbeMemo, null);
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].fields.providerMs, { convertigo: 400, codex: 6000, vibe: 30, claude: 2500 });
  assert.deepEqual(lines[0].steps.map(step => step.step), ['settings/providers', 'settings/discover']);
  assert.equal(lines[0].steps[0].ms, 8930, 'settings/providers keeps its meaning');
});

test('an empty or blank JSON file reads as nothing, without trimming the whole text', () => {
  withGlobals({ readTextFile: file => file.text }, () => {
    assert.equal(readJsonFile({ text: '' }), null);
    assert.equal(readJsonFile({ text: ' \n\t ' }), null);
    assert.deepEqual(readJsonFile({ text: '\n  {"checks": {}}\n' }), { checks: {} });
    assert.equal(readJsonFile({ text: '{broken' }), null);
  });
});
