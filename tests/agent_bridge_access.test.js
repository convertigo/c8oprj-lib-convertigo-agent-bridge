// Caller check of the Bridge sequences (js/agent_bridge_access.js): no anonymous caller, a WEB_ADMIN session or the
// Assistant of this engine with the engine caller key.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const OWN_CHECK = ['agent_quota', 'agent_session_metrics'];

class EngineException extends Error {}

function load({ admin = false, key = null, store = new Map() } = {}) {
  const warnings = [];
  const Packages = {
    java: {
      lang: { reflect: { Array: { newInstance: (_type, size) => Buffer.alloc(size) } }, Byte: { TYPE: 'byte' },
        String: function (text) { this.getBytes = () => Buffer.from(String(text), 'utf8'); } },
      security: { SecureRandom: function () { this.nextBytes = bytes => crypto.randomFillSync(bytes); },
        MessageDigest: { isEqual: (a, b) => a.equals(b) } },
      util: { Base64: { getUrlEncoder: () => ({ withoutPadding: () => ({ encodeToString: bytes => Buffer.from(bytes).toString('base64url') }) }) } },
      nio: { charset: { StandardCharsets: { UTF_8: 'utf8' } } }
    },
    org: { mozilla: { javascript: { Synchronizer: function (fn) { return fn; } } } },
    com: { twinsoft: { convertigo: { engine: {
      Engine: { authenticatedSessionManager: { hasRole: (session, role) => role === 'WEB_ADMIN' && session.admin === true } },
      AuthenticatedSessionManager: { Role: { WEB_ADMIN: 'WEB_ADMIN' } },
      EngineException
    } } } }
  };
  const sandbox = {
    Packages, C8O: { agentBridge: {} }, log: { warn: text => warnings.push(text) },
    context: {
      server: { get: name => store.get(name) ?? null, set: (name, value) => store.set(name, value) },
      httpSession: { admin },
      httpServletRequest: { getHeader: name => name === 'X-Convertigo-Agent-Bridge-Key' ? key : null, getRemoteAddr: () => '192.168.1.20' },
      requestedObject: { getName: () => 'agent_events' }
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'js/agent_bridge_access.js'), 'utf8'), sandbox);
  return { bridge: sandbox.C8O.agentBridge, warnings, store };
}

test('every Public sequence checks its caller first; the two others keep their own WEB_ADMIN check', () => {
  const dir = path.join(root, '_c8oProject/sequences');
  const names = fs.readdirSync(dir).filter(name => name.endsWith('.yaml')).map(name => name.slice(0, -5));
  assert.ok(names.length >= 21);
  for (const name of names) {
    const yaml = fs.readFileSync(path.join(dir, name + '.yaml'), 'utf8');
    if (OWN_CHECK.includes(name)) {
      assert.match(yaml, /Role\.WEB_ADMIN/, name);
      continue;
    }
    assert.match(yaml, /^    '?include\("js\/vibe_agent_bridge\.js"\);\n    C8O\.agentBridge\.requireCaller\(\);\n/m, name);
  }
  assert.match(fs.readFileSync(path.join(root, 'js/vibe_agent_bridge.js'), 'utf8'), /include\("js\/agent_bridge_access\.js"\);/);
});

test('anonymous callers are refused and logged', () => {
  const { bridge, warnings } = load();
  assert.throws(() => bridge.requireCaller(), error => error instanceof EngineException && /agent_bridge_caller_refused/.test(error.message));
  assert.match(warnings[0], /refused agent_events from 192\.168\.1\.20/);
});

test('a WEB_ADMIN session is accepted', () => {
  assert.doesNotThrow(() => load({ admin: true }).bridge.requireCaller());
});

test('the engine caller key is accepted, any other key refused', () => {
  const store = new Map();
  const key = load({ store }).bridge.callerKey();
  assert.match(key, /^[A-Za-z0-9_-]{43}$/, '32 random bytes, base64url');
  assert.equal(load({ store }).bridge.callerKey(), key, 'created once, then read from the server store');
  assert.doesNotThrow(() => load({ store, key }).bridge.requireCaller());
  const wrong = load({ store, key: key.slice(0, -1) + (key.endsWith('A') ? 'B' : 'A') });
  assert.throws(() => wrong.bridge.requireCaller(), /agent_bridge_caller_refused/);
  assert.match(wrong.warnings[0], /wrong caller key/);
  assert.throws(() => load({ store, key: '' }).bridge.requireCaller(), /agent_bridge_caller_refused/);
});

test('a new engine store means a new key', () => {
  assert.notEqual(load().bridge.callerKey(), load().bridge.callerKey());
});
