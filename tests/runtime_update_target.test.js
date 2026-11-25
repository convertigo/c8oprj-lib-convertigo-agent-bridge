// The managed Vibe runtime is the 3.1 line: any 3.1.x is fine, an install asks pip for the newest 3.1.x
// ("mistral-vibe>=3.1.0,<3.2") and the update offer targets the newest 3.1.x the registry has, never 3.2 or later.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const proxy = new Proxy(function () {}, { get(_t, p) { return p === Symbol.toPrimitive ? () => '' : proxy; }, apply() { return proxy; }, construct() { return proxy; } });
// pip index versions, as pip 24-25 prints it: the newest version, then every released version, newest first.
const PIP_INDEX = 'mistral-vibe (3.2.0)\nAvailable versions: 3.2.0, 3.1.5, 3.1.4, 3.1.3, 3.1.2, 3.1.1, 3.1.0, 3.0.4, 3.0.3, 2.26.1';
function fixture(cached, stdout) {
  const s = { Packages: proxy, context: proxy, request: proxy, log: proxy, C8O: { agentBridge: {} } };
  vm.createContext(s);
  vm.runInContext(fs.readFileSync('js/agent_bridge_common.js', 'utf8'), s);
  s.commandPathStartsWith = () => true;
  s.readCachedRuntimeUpdate = () => cached ? JSON.parse(JSON.stringify(cached)) : null;
  s.cachedRuntimeUpdate = (_key, _options, _workspace, check) => check();
  s.runCommandCaptured = () => ({ ok: true, stdout: stdout || PIP_INDEX, stderr: '' });
  const setup = { workspaceRoot: '/fixture', venvDir: '/fixture/venv', vibe: { found: true }, python: { found: true, path: '/fixture/python' } };
  return { s, setup };
}
const statusOf = (s, latest) => version => s.runtimeUpdateStatus('vibe', { found: true, path: '/fixture/venv/vibe', version: 'vibe ' + version }, latest, 'pypi');

test('installs ask pip for the newest release of the 3.1 line', () => {
  const { s } = fixture(null);
  assert.equal(s.managedVibePackageRequirement(), 'mistral-vibe>=3.1.0,<3.2');
});

test('a fresh registry check keeps the released versions; the target is the newest 3.1.x, never 3.2', () => {
  const { s, setup } = fixture(null);
  const latest = s.vibeLatestVersion({ checkUpdates: true }, setup);
  assert.equal(latest.latestVersion, '3.2.0', 'the registry result is preserved');
  assert.deepEqual([...latest.versions].slice(0, 3), ['3.2.0', '3.1.5', '3.1.4']);
  const status = statusOf(s, latest);
  assert.equal(status('3.1.0').latestVersion, '3.1.5');
  assert.equal(status('3.1.0').targetVersion, '3.1.5');
  assert.equal(status('3.1.0').availableVersion, '3.2.0');
  assert.equal(status('3.1.0').updateAvailable, true, 'a newer 3.1.x exists');
  assert.equal(status('3.1.3').updateAvailable, true);
  assert.equal(status('3.1.5').updateAvailable, false, 'the newest 3.1.x is up to date');
  assert.equal(status('3.0.4').latestVersion, '3.1.5', 'an older line is offered the newest 3.1.x');
  assert.equal(status('3.0.4').updateAvailable, true);
  assert.equal(status('2.26.1').updateAvailable, true);
  assert.equal(status('3.2.0').updateAvailable, false, 'a newer runtime is never offered an older target');
});

test('an installed 3.1.x is up to date while the registry has no newer 3.1.x', () => {
  const { s, setup } = fixture(null, 'mistral-vibe (3.1.0)\nAvailable versions: 3.1.0, 3.0.4');
  const status = statusOf(s, s.vibeLatestVersion({ checkUpdates: true }, setup));
  assert.equal(status('3.1.0').updateAvailable, false);
  assert.equal(status('3.1.0').latestVersion, '3.1.0');
  assert.equal(status('3.0.4').updateAvailable, true);
});

test('a check cached before the version list was kept follows the line without being rewritten', () => {
  for (const [cachedLatest, target] of [['3.1.1', '3.1.1'], ['3.2.0', '3.1.0'], ['3.0.4', '3.1.0']]) {
    const cached = { checked: true, cached: true, latestVersion: cachedLatest };
    const { s, setup } = fixture(cached);
    const latest = s.vibeLatestVersion({ checkUpdates: false }, setup);
    assert.equal(latest.latestVersion, cachedLatest, 'the cache is read as it is');
    const status = statusOf(s, latest);
    assert.equal(status('3.0.4').latestVersion, target, cachedLatest);
    assert.equal(status('3.1.0').updateAvailable, target !== '3.1.0', cachedLatest);
  }
});

test('pre-releases and other lines are never a target', () => {
  const { s } = fixture(null);
  assert.equal(s.managedVibeTargetVersion({ latestVersion: '3.2.0', versions: ['3.2.0', '3.1.6rc1', '3.1.6-beta.1', '3.1.2', '31.1.9'] }), '3.1.2');
  assert.equal(s.managedVibeTargetVersion({}), '3.1.0');
});

test('without a registry check the offer stays empty, as before', () => {
  const { s, setup } = fixture(null);
  const status = statusOf(s, s.vibeLatestVersion({ checkUpdates: false }, setup))('3.1.0');
  assert.equal(status.latestVersion, '');
  assert.equal(status.updateAvailable, false);
  assert.equal(status.targetVersion, '3.1.0');
});

test('unmanaged runtime updates retain their registry version', () => {
  const { s } = fixture(null);
  assert.equal(s.runtimeUpdateStatus('codex', { found: true, version: 'codex 0.1.0' }, { checked: true, latestVersion: '0.2.0' }, 'npm').latestVersion, '0.2.0');
});
