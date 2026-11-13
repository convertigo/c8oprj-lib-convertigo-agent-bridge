const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const proxy = new Proxy(function () {}, { get(_t, p) { return p === Symbol.toPrimitive ? () => '' : proxy; }, apply() { return proxy; }, construct() { return proxy; } });
function fixture(cached) {
  const s = { Packages: proxy, context: proxy, request: proxy, log: proxy, C8O: { agentBridge: {} } };
  vm.createContext(s);
  vm.runInContext(fs.readFileSync('js/agent_bridge_common.js', 'utf8'), s);
  s.commandPathStartsWith = () => true;
  s.readCachedRuntimeUpdate = () => cached ? { checked: true, cached: true, latestVersion: '3.1.1' } : null;
  s.cachedRuntimeUpdate = (_key, _options, _workspace, check) => check();
  s.runCommandCaptured = () => ({ ok: true, stdout: 'mistral-vibe (3.1.1)\nAvailable versions: 3.1.1, 3.1.0', stderr: '' });
  const setup = { workspaceRoot: '/fixture', venvDir: '/fixture/venv', vibe: { found: true }, python: { found: true, path: '/fixture/python' } };
  return { s, setup };
}
for (const cached of [false, true]) {
  test(`update offers the installable managed target, ${cached ? 'from an existing cache' : 'from a fresh index check'}`, () => {
    const { s, setup } = fixture(cached);
    const latest = s.vibeLatestVersion({ checkUpdates: !cached }, setup);
    const status = version => s.runtimeUpdateStatus('vibe', { found: true, path: '/fixture/venv/vibe', version: 'vibe ' + version }, latest, 'pypi');
    assert.equal(status('2.26.1').latestVersion, '3.1.0');
    assert.equal(status('2.26.1').updateAvailable, true);
    assert.equal(s.managedVibePackageRequirement(), 'mistral-vibe==' + status('2.26.1').latestVersion);
    assert.equal(status('3.1.0').availableVersion, '3.1.1');
    assert.equal(status('3.1.0').updateAvailable, false, 'a successful managed install clears the update offer');
    assert.equal(status('3.1.1').updateAvailable, false, 'a newer existing runtime is not offered an update to an older target');
    assert.equal(latest.latestVersion, '3.1.1', 'the registry result is preserved');
  });
}
test('unmanaged runtime updates retain their registry version', () => {
  const { s } = fixture(false);
  assert.equal(s.runtimeUpdateStatus('codex', { found: true, version: 'codex 0.1.0' }, { checked: true, latestVersion: '0.2.0' }, 'npm').latestVersion, '0.2.0');
});
