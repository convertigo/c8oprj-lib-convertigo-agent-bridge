// Vibe processes used to live until the engine stopped: only Codex and Claude starts swept, and the No Code server kept
// every conversation's vibe-acp (165 MB each, 8 of them on test-nocode). The sweep now runs at each Vibe start, on
// event reads and every minute; a No Code process stops after 20 min idle, a prewarmed one after 3 min without its
// first message, and a No Code user keeps at most 3 Vibe processes, never losing one in a turn.
// node --test tests/vibe_process_guards.test.js
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
const startSequence = fs.readFileSync(path.join(root, '_c8oProject/sequences/agent_vibe_start.yaml'), 'utf8');

const MIN = 60000;
const NOW = 100 * MIN;

function registryOf(entries) {
  const map = new Map(entries.map(entry => [entry.handle, entry]));
  return {
    map,
    keySet: () => ({ iterator: () => { const keys = [...map.keys()]; let i = 0; return { hasNext: () => i < keys.length, next: () => keys[i++] }; } }),
    get: handle => map.has(handle) ? map.get(handle) : null,
    remove: handle => { map.delete(handle); }
  };
}

function vibe(handle, fields) {
  return Object.assign({ handle, provider: 'vibe', status: 'running', noCode: true, ownerKey: 'u1', prewarm: false,
    turnActive: false, createdAt: NOW - 30 * MIN, lastAccess: NOW - MIN, ttlMillis: 20 * MIN, workspaceRoot: '/workspace',
    process: { isAlive: () => true } }, fields);
}

function withFakes(run) {
  const stops = [];
  const lines = [];
  const fakes = {
    now: () => NOW,
    stopEntry: entry => { stops.push(entry.handle); entry.status = 'closed'; },
    statusOf: entry => ({ handle: entry.handle }),
    forgetSessionHandle() {},
    writeStartupTimings: (timer, workspaceRoot, outcome) => { lines.push(Object.assign({ kind: timer.kind, workspaceRoot, outcome }, timer.fields)); }
  };
  const saved = {};
  for (const [name, value] of Object.entries(fakes)) { saved[name] = global[name]; global[name] = value; }
  try { return Object.assign(run(), { stops, lines }); } finally { for (const [name, value] of Object.entries(saved)) global[name] = value; }
}

test('the sweep stops the dead, the idle beyond their TTL and the prewarms idle 3 min, and traces each stop', () => {
  const registry = registryOf([
    vibe('dead', { process: { isAlive: () => false } }),
    vibe('idle-21min', { lastAccess: NOW - 21 * MIN }),
    vibe('idle-19min', { lastAccess: NOW - 19 * MIN }),
    vibe('turn-30min', { lastAccess: NOW - 30 * MIN, turnActive: true }),
    vibe('prewarm-4min', { prewarm: true, lastAccess: NOW - 4 * MIN, ownerKey: 'u2' }),
    vibe('prewarm-2min', { prewarm: true, lastAccess: NOW - 2 * MIN, ownerKey: 'u3' }),
    vibe('starting', { status: 'starting', process: null, createdAt: NOW - 5000, lastAccess: NOW - 5000, ownerKey: 'u4' })
  ]);
  const { result, stops, lines } = withFakes(() => ({ result: sweepRegistry(registry, {}) }));
  assert.deepEqual(stops.sort(), ['dead', 'idle-21min', 'prewarm-4min']);
  assert.deepEqual(result.stopped.map(s => s.handle + ':' + s.reason).sort(), ['dead:dead', 'idle-21min:idle', 'prewarm-4min:prewarm_expired']);
  assert.deepEqual([...registry.map.keys()].sort(), ['idle-19min', 'prewarm-2min', 'starting', 'turn-30min'], 'a turn keeps at least 1 h, a start its grace');
  assert.equal(lines.length, 3);
  const idle = lines.find(line => line.handle === 'idle-21min');
  assert.equal(idle.kind, 'stop');
  assert.equal(idle.reason, 'idle');
  assert.equal(idle.outcome, 'idle');
  assert.equal(idle.workspaceRoot, '/workspace');
  assert.equal(idle.idleMs, 21 * MIN);
  assert.equal(idle.aliveMs, 30 * MIN);
});

test('a No Code user keeps 3 Vibe processes: the least recently used idle ones stop, never one in a turn', () => {
  const registry = registryOf([
    vibe('a', { lastAccess: NOW - 10 * MIN, turnActive: true }),
    vibe('b', { lastAccess: NOW - 8 * MIN }),
    vibe('c', { lastAccess: NOW - 6 * MIN }),
    vibe('d', { lastAccess: NOW - 4 * MIN }),
    vibe('e', { lastAccess: NOW - 2 * MIN }),
    vibe('studio-1', { noCode: false, ownerKey: 'studio', ttlMillis: 60 * MIN }),
    vibe('studio-2', { noCode: false, ownerKey: 'studio', ttlMillis: 60 * MIN }),
    vibe('studio-3', { noCode: false, ownerKey: 'studio', ttlMillis: 60 * MIN }),
    vibe('studio-4', { noCode: false, ownerKey: 'studio', ttlMillis: 60 * MIN }),
    vibe('probe', { ownerKey: '' })
  ]);
  const { result } = withFakes(() => ({ result: sweepRegistry(registry, {}) }));
  assert.deepEqual(result.stopped.map(s => s.handle + ':' + s.reason), ['b:user_limit', 'c:user_limit']);
  assert.deepEqual([...registry.map.keys()].filter(h => !h.startsWith('studio')).sort(), ['a', 'd', 'e', 'probe'],
    'the Studio and settings probes have no limit');
  assert.deepEqual(result.kept.map(k => k.handle).filter(h => /^[a-e]$/.test(h)).sort(), ['a', 'd', 'e']);
});

test('a new process of a user stops the least recently used idle one above 3, and a new prewarm the previous one', () => {
  const registry = registryOf([
    vibe('old', { lastAccess: NOW - 9 * MIN }),
    vibe('mid', { lastAccess: NOW - 5 * MIN }),
    vibe('recent', { lastAccess: NOW - MIN }),
    vibe('other-user', { ownerKey: 'u9', lastAccess: NOW - 30 * MIN, ttlMillis: 60 * MIN })
  ]);
  const fresh = vibe('new', { status: 'starting', process: null, createdAt: NOW, lastAccess: NOW });
  registry.map.set('new', fresh);
  const first = withFakes(() => ({ stopped: enforceUserLimit(registry, fresh) }));
  assert.deepEqual(first.stopped.map(s => s.handle + ':' + s.reason), ['old:user_limit']);
  const prewarm = vibe('prewarm-1', { prewarm: true, lastAccess: NOW - MIN, ownerKey: 'u5' });
  const next = vibe('prewarm-2', { prewarm: true, status: 'starting', process: null, createdAt: NOW, lastAccess: NOW, ownerKey: 'u5' });
  const prewarms = registryOf([prewarm, next]);
  const second = withFakes(() => ({ stopped: enforceUserLimit(prewarms, next) }));
  assert.deepEqual(second.stopped.map(s => s.handle + ':' + s.reason), ['prewarm-1:prewarm_replaced'], 'one prewarm per user');
});

test('the events read sweeps at most every 10 s and never the conversation it reads', () => {
  let clockValue = 0;
  const clock = { get: () => clockValue, compareAndSet: (expected, value) => { if (clockValue !== expected) return false; clockValue = value; return true; } };
  const registry = registryOf([vibe('read', { lastAccess: NOW - 25 * MIN }), vibe('other', { lastAccess: NOW - 25 * MIN })]);
  const first = withFakes(() => ({ result: sweepIfDue(registry, clock, 10000, { keep: 'read' }) }));
  assert.deepEqual(first.result.stopped.map(s => s.handle), ['other']);
  const second = withFakes(() => ({ result: sweepIfDue(registry, clock, 10000, { keep: 'read' }) }));
  assert.equal(second.result, null, 'one sweep in 10 s');
  assert.ok(registry.map.has('read'));
  assert.match(commonSource, /ensureAgentReaper\(\);\n\s+try \{\n\s+sweepIfDue\(getRegistry\(\), sweepClock\(\), SWEEP_MIN_INTERVAL_MILLIS, \{ keep: handle \}\);/);
});

test('one reaper thread per engine sweeps every minute and gives way to a newer revision', () => {
  const properties = {};
  const threads = [];
  const saved = { System: global.System, Thread: global.Thread, Runnable: global.Runnable, UUID: global.UUID, now: global.now, getRegistry: global.getRegistry, sweepClock: global.sweepClock, sweepIfDue: global.sweepIfDue };
  let sweeps = 0;
  let uuid = 0;
  global.System = { getProperty: key => properties[key] ?? null, setProperty: (key, value) => { properties[key] = value; } };
  global.Thread = function (runnable, name) { this.runnable = runnable; this.name = name; this.setDaemon = d => { this.daemon = d; }; this.start = () => threads.push(this); };
  global.Thread.sleep = () => {};
  global.Runnable = function (impl) { return impl; };
  global.UUID = { randomUUID: () => 'id-' + (++uuid) };
  global.now = () => NOW;
  global.getRegistry = () => registryOf([]);
  global.sweepClock = () => ({});
  global.sweepIfDue = () => { sweeps++; return null; };
  try {
    assert.equal(ensureAgentReaper(), true);
    assert.equal(ensureAgentReaper(), false, 'already running');
    assert.equal(threads.length, 1);
    assert.equal(threads[0].daemon, true);
    assert.equal(threads[0].name, 'c8o-agent-bridge-reaper');
    assert.equal(reaperTick('id-1', null, null), true);
    assert.equal(sweeps, 1);
    // an older revision's thread stops at its next tick
    properties['lib_ConvertigoAgentBridge.reaper'] = '0|id-0|' + NOW;
    assert.equal(ensureAgentReaper(), true);
    assert.equal(reaperTick('id-1', null, null), false);
    assert.equal(reaperTick('id-2', null, null), true);
    // a reaper that stopped beating is replaced
    properties['lib_ConvertigoAgentBridge.reaper'] = '1|id-2|' + (NOW - 4 * MIN);
    assert.equal(ensureAgentReaper(), true);
  } finally {
    Object.assign(global, saved);
  }
});

test('Vibe starts sweep, apply the No Code TTL and the user limit, and the prewarm is taken by the first start or prompt', () => {
  assert.match(vibeSource, /ensureAgentReaper\(\);\n\s+try \{\n\s+sweepIfDue\(registry, sweepClock\(\), 0, \{\}\);/);
  assert.match(vibeSource, /intValue\(options\.ttlSeconds, noCode \? NOCODE_TTL_SECONDS : DEFAULT_TTL_SECONDS, 30, 86400\)/);
  assert.match(vibeSource, /registry\.put\(handle, entry\);\n\s+try \{\n\s+enforceUserLimit\(registry, entry\);/);
  assert.match(vibeSource, /existing\.status === "starting"\) \{\n\s+if \(!waitWhileStarting\(existing, STARTING_GRACE_MILLIS\)\)/);
  assert.match(vibeSource, /if \(boolValue\(options\.prewarm, false\) && existing !== null[^{]+\{\n\s+return \{ ok: true, status: "already_running"/, 'a late prewarm leaves the process alone');
  assert.match(vibeSource, /if \(existing\.prewarm === true && !boolValue\(options\.prewarm, false\)\) \{[^}]*existing\.prewarm = false;/);
  assert.match(vibeSource, /"received"\);\n\s+entry\.prewarm = false;/);
  assert.match(vibeSource, /existing\.prewarm = false;\n\s+\}\n\s+\/\/ its prompt follows[^\n]*\n\s+existing\.lastAccess = now\(\);/);
  assert.match(vibeSource, /settingsProbe: true,/);
  assert.match(startSequence, /prewarm: typeof prewarm === "undefined" \? false : prewarm\n\s+\}\);'/);
  assert.match(startSequence, /\n↓prewarm \[variables\.RequestableVariable-\d+\]: \n  comment: [^\n]+\n  description: [^\n]+\n  schemaType: xsd:boolean/);
  assert.equal(NOCODE_TTL_SECONDS, 1200);
  assert.equal(PREWARM_TTL_MILLIS, 180000);
  assert.equal(NOCODE_MAX_VIBE_PER_USER, 3);
});

test('a start waits for the prewarm of its conversation still starting', () => {
  const entry = { status: 'starting' };
  let ticks = 0;
  const saved = { Thread: global.Thread, now: global.now };
  global.Thread = { sleep: () => { if (++ticks === 3) entry.status = 'running'; } };
  let clock = 0;
  global.now = () => (clock += 100);
  try {
    assert.equal(waitWhileStarting(entry, 10000), true);
    assert.equal(ticks, 3);
    const stuck = { status: 'starting' };
    assert.equal(waitWhileStarting(stuck, 1000), false);
  } finally {
    Object.assign(global, saved);
  }
});
