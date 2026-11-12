// The Studio on the desktop: the Eclipse Studio (Studio mode) and the Electron Studio, whose engine is a desktop Studio
// without Studio mode (Engine.isDesktopStudio, Convertigo 8.5). The PSC is read through the engine where it can
// (engine.studio.StudioPsc), else through the Eclipse Studio (ConvertigoPlugin.decodePsc).
// node --test tests/desktop_studio.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const ENGINES = {
  eclipse: { isStudioMode: () => true },
  electron: { isStudioMode: () => false, isDesktopStudio: () => true },
  server: { isStudioMode: () => false, isDesktopStudio: () => false },
  server84: { isStudioMode: () => false }
};
const DESKTOP = ['eclipse', 'electron'];

function stepSource(file) {
  const yaml = read(file).split('\n');
  const start = yaml.findIndex(l => /expression: \|/.test(l));
  const indent = yaml[start].search(/\S/), lines = [];
  for (let i = start + 1; i < yaml.length; i++) {
    if (yaml[i].trim() && yaml[i].search(/\S/) <= indent) break;
    lines.push(yaml[i].slice(indent + 2));
  }
  return lines.join('\n').trim();
}

test('agent_quota: the WEB_ADMIN of a desktop Studio as "studio", a server user as themself', () => {
  const source = stepSource('_c8oProject/sequences/agent_quota.yaml');
  const guard = source.slice(0, source.indexOf('include('));
  const run = (kind, admin, user) => {
    const Engine = { ...ENGINES[kind], authenticatedSessionManager: { hasRole: (_s, role) => role === 'WEB_ADMIN' && admin } };
    const com = { twinsoft: { convertigo: { engine: { Engine, AuthenticatedSessionManager: { Role: { WEB_ADMIN: 'WEB_ADMIN' } },
      EngineException: class extends Error {} } } } };
    const box = { com, context: { httpSession: {}, getAuthenticatedUser: () => user } };
    vm.runInNewContext(guard + '\nuserId=studio?"studio":String(context.getAuthenticatedUser()||"");', box);
    return box.userId;
  };
  for (const kind of DESKTOP) {
    assert.equal(run(kind, true, 'c8o:admin'), 'studio', kind);
    assert.throws(() => run(kind, false, 'forms-user'), /Authenticated quota caller required/, kind);
  }
  for (const kind of ['server', 'server84']) {
    assert.equal(run(kind, false, 'alice@example.com'), 'alice@example.com', kind);
    assert.throws(() => run(kind, false, ''), /Authenticated quota caller required/, kind);
  }
});

function pscReader(packages) {
  const source = read('js/agent_bridge_common.js');
  const parts = ['studioPscProperties', 'studioOwnerEmail'].map(name =>
    source.match(new RegExp('\\n  function ' + name + '\\(\\) \\{\\n[\\s\\S]*?\\n  \\}\\n'))[0]);
  const box = { Packages: packages, trim: value => String(value ?? '').trim() };
  vm.runInNewContext(parts.join('\n'), box);
  return box;
}

function properties(email) {
  return { getProperty: name => (name === 'owner.email' ? email : null) };
}

// What Rhino gives for a class that is not there: a package, whose members are packages again (typeof "object").
function javaPackage() {
  return new Proxy({}, { get: () => javaPackage() });
}

test('the PSC owner comes from the engine (8.5), else from the Eclipse Studio (8.4), else nothing', () => {
  const engine85 = { com: { twinsoft: { convertigo: {
    engine: { studio: { StudioPsc: { decode: () => properties('dev@example.com') } } },
    eclipse: { ConvertigoPlugin: { decodePsc: () => { throw new Error('not asked'); } } } } } } };
  assert.equal(pscReader(engine85).studioOwnerEmail(), 'dev@example.com');

  const eclipse84 = { com: { twinsoft: { convertigo: {
    engine: javaPackage(),
    eclipse: { ConvertigoPlugin: { decodePsc: () => properties('eclipse@example.com') } } } } } };
  assert.equal(pscReader(eclipse84).studioOwnerEmail(), 'eclipse@example.com');

  const server84 = { com: { twinsoft: { convertigo: javaPackage() } } };
  assert.equal(pscReader(server84).studioOwnerEmail(), '', 'no PSC reader: no owner');

  const noPsc = { com: { twinsoft: { convertigo: {
    engine: { studio: { StudioPsc: { decode: () => { throw new Error('PscException: no psc.txt'); } } } } } } } };
  assert.equal(pscReader(noPsc).studioOwnerEmail(), '', 'a desktop Studio without PSC yet');
});
