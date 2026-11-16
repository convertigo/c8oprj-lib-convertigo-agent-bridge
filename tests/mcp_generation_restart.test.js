// test-nocode 16/11: a No Code conversation prewarmed while AgentStackInstall replaced lib_ConvertigoMCP had no
// Convertigo tool for its whole life. Vibe resolves its MCP servers when its session starts and its core refuses to
// reconfigure them during a turn. vibeStart now notes the lib_ConvertigoMCP its session starts with (its generation:
// version and loaded project), waits while the project is being replaced, starts the session again once when the MCP
// changed while it started, and restarts a resident or prewarmed session whose MCP was installed since. These tests
// replay the install with an engine whose loaded MCP goes through the steps of AgentStackInstall.
// node --test tests/mcp_generation_restart.test.js
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

// An engine clock and the lib_ConvertigoMCP it has loaded at each moment: [fromMs, generation].
function engine(timeline) {
  let clock = 0;
  const saved = { mcpGenerationProbe, mcpGenerationSleep, now, stopEntry, pushEvent, startupMark };
  const stopped = [];
  const events = [];
  mcpGenerationProbe = () => {
    let current = '';
    for (const [from, generation] of timeline) if (clock >= from) current = generation;
    return current;
  };
  mcpGenerationSleep = ms => { clock += ms; };
  now = () => clock;
  stopEntry = (entry, remove) => { stopped.push([entry.handle, remove]); };
  pushEvent = (entry, kind, fields) => { events.push(Object.assign({ kind }, fields)); };
  startupMark = () => {};
  return {
    stopped, events,
    advance: ms => { clock += ms; },
    at: () => clock,
    restore: () => {
      mcpGenerationProbe = saved.mcpGenerationProbe; mcpGenerationSleep = saved.mcpGenerationSleep; now = saved.now;
      stopEntry = saved.stopEntry; pushEvent = saved.pushEvent; startupMark = saved.startupMark;
    }
  };
}

const B32 = '0.3.0-beta.32@11';
const B33 = '0.3.0-beta.33@22';

test('a session that started while AgentStackInstall replaced the MCP is started again once, with the new MCP', () => {
  // the prewarm reads the old MCP, the install removes it 2 s later, loads the new one at 9 s; Vibe's session/new ends at 12 s
  const e = engine([[0, B32], [2000, ''], [5000, 'absent'], [9000, B33]]);
  try {
    const before = vibeMcpGenerationBeforeStart(false);
    assert.equal(before, B32);
    e.advance(12000);
    const entry = { handle: 'agent-1', settingsProbe: false, mcpGeneration: before };
    const starts = [];
    const answer = vibeRestartIfMcpChanged(entry, before, { handle: 'agent-1', prewarm: true, conversationId: 'agent-1' }, again => {
      starts.push(Object.assign({ at: e.at() }, again));
      // the second start reads the MCP as it is now, and keeps it
      const second = { handle: 'agent-1', settingsProbe: false, mcpGeneration: vibeMcpGenerationBeforeStart(false) };
      assert.equal(vibeRestartIfMcpChanged(second, second.mcpGeneration, again, () => assert.fail('no third start')), null);
      return { ok: true, status: 'started', handle: 'agent-1', mcpGeneration: second.mcpGeneration };
    });
    assert.deepEqual(e.stopped, [['agent-1', true]]);
    assert.equal(e.events[0].reason, 'mcp_changed_while_starting');
    assert.equal(e.events[0].before, B32);
    assert.equal(e.events[0].after, B33);
    assert.equal(starts.length, 1);
    assert.equal(starts[0].mcpGenerationRetry, true);
    assert.equal(starts[0].prewarm, true);
    // it waited for the new MCP to stay loaded MCP_GENERATION_STABLE_MS before starting again
    assert.ok(starts[0].at >= 12000 + MCP_GENERATION_STABLE_MS, String(starts[0].at));
    assert.equal(answer.mcpGeneration, B33);
  } finally {
    e.restore();
  }
});

test('a start during the install waits for the new MCP; one that changes twice answers an error, never a session without tools', () => {
  let e = engine([[0, ''], [4000, B33]]);
  try {
    assert.equal(vibeMcpGenerationBeforeStart(false), B33);
    assert.ok(e.at() >= 4000 + MCP_GENERATION_STABLE_MS);
  } finally {
    e.restore();
  }
  e = engine([[0, '']]);
  try {
    assert.equal(vibeMcpGenerationBeforeStart(false), null, 'an MCP that never comes back');
    assert.ok(e.at() >= MCP_GENERATION_WAIT_MS);
  } finally {
    e.restore();
  }
  e = engine([[0, B32], [1000, B33]]);
  try {
    e.advance(2000);
    const answer = vibeRestartIfMcpChanged({ handle: 'agent-2' }, B32, { mcpGenerationRetry: true }, () => assert.fail('no third start'));
    assert.equal(answer.ok, false);
    assert.equal(answer.phase, 'mcp/unavailable');
    assert.equal(answer.error, VIBE_MCP_UPDATING_MESSAGE);
    assert.deepEqual(e.stopped, [['agent-2', true]]);
  } finally {
    e.restore();
  }
});

test('a settings probe, an unchanged MCP and a server without the MCP start as before', () => {
  const e = engine([[0, B32]]);
  try {
    assert.equal(vibeMcpGenerationBeforeStart(true), '');
    assert.equal(vibeRestartIfMcpChanged({ handle: 'p', settingsProbe: true }, '', {}, () => assert.fail()), null);
    assert.equal(vibeRestartIfMcpChanged({ handle: 'a' }, B32, {}, () => assert.fail()), null);
    assert.equal(e.at(), 0, 'no wait while the MCP is loaded');
  } finally {
    e.restore();
  }
  const absent = engine([[0, 'absent']]);
  try {
    assert.equal(vibeMcpGenerationBeforeStart(false), 'absent');
    assert.equal(vibeMcpGenerationStale({ mcpGeneration: 'absent' }), false);
  } finally {
    absent.restore();
  }
});

test('a resident or prewarmed session whose MCP was installed since restarts on the same session before its turn', () => {
  const e = engine([[0, B33]]);
  try {
    assert.equal(vibeMcpGenerationStale({ mcpGeneration: B32 }), true);
    assert.equal(vibeMcpGenerationStale({ mcpGeneration: B33 }), false);
    // a process of a Bridge older than the guard has no generation: it reads its tools again once
    assert.equal(vibeMcpGenerationStale({}), true);
    assert.equal(vibeMcpGenerationStale({ settingsProbe: true }), false);
  } finally {
    e.restore();
  }
  assert.match(vibeSource, /&& \(existing\.status === "starting" \|\| \(processAlive\(existing\.process\) && !vibeMcpGenerationStale\(existing\)\)\)\) \{/);
  assert.match(vibeSource, /var mcpGenerationChanged = vibeMcpGenerationStale\(existing\);/);
  const branch = vibeSource.slice(vibeSource.indexOf('} else if (mcpGenerationChanged) {'), vibeSource.indexOf('} else if (catalogChanged) {'));
  assert.match(branch, /options\.sessionId = trim\(existing\.sessionId\);/);
  assert.match(branch, /reason: "mcp_generation_changed"/);
  assert.match(branch, /stopEntry\(existing, true\);\n\s+existing = null;/);
});

test('vibeStart notes the generation each session starts with and checks it once Vibe has read its tools', () => {
  assert.match(vibeSource, /var mcpBefore = vibeMcpGenerationBeforeStart\(settingsProbe\);\n\s+if \(mcpBefore === null\) \{\n\s+return \{ ok: false, status: "error", phase: "mcp\/unavailable"/);
  assert.match(vibeSource, /entry\.settingsProbe = settingsProbe;\n\s+entry\.mcpGeneration = mcpBefore;/);
  const configure = vibeSource.indexOf('startupMark("configure");');
  const check = vibeSource.indexOf('var mcpChanged = vibeRestartIfMcpChanged(entry, mcpBefore, options, vibeStartSteps);');
  const ready = vibeSource.indexOf('entry.phase = "ready";', configure);
  assert.ok(configure > 0 && check > configure && check < ready, 'the check runs after session/new and the configuration, before the session is ready');
  // the probe reads the loaded project, by version and identity, and the project folder for "absent"
  assert.match(commonSource, /manager\.existsProject\(MCP_CATALOG_PROJECT\) !== true/);
  assert.match(commonSource, /trim\(project\.getVersion\(\)\) \+ "@" \+ Packages\.java\.lang\.System\.identityHashCode\(project\)/);
});
