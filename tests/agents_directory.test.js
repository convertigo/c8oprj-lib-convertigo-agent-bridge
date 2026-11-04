const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const entries = fs.readdirSync(path.join(root, 'js')).filter(name => name.endsWith('.js')).filter(name => fs.readFileSync(path.join(root, 'js', name), 'utf8').startsWith('// Shared storage contract'));
class File {
  constructor(parent, child) { this.path = child === undefined ? String(parent) : String(parent) + '/' + child; }
  isAbsolute() { return this.path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(this.path) || /^\\\\[^\\]+\\[^\\]+/.test(this.path); }
  getParentFile() { return /^(?:\/?|[A-Za-z]:[\\/]?|\\\\[^\\]+\\[^\\]+\\?)$/.test(this.path) ? null : new File('parent'); }
  toString() { return this.path; }
}
function load(name, symbol) {
  const source = fs.readFileSync(path.join(root, 'js', name), 'utf8').split('// End shared storage contract.')[0];
  const box = { Packages: { com: { twinsoft: { convertigo: { engine: { Engine: { theApp: { databaseObjectsManager: { symbolsGetValue(key) { assert.equal(key, 'assistant.agents.directory'); return symbol; } } } } } } } } } };
  vm.runInNewContext(source, box);
  return box.C8O.tigoAgentsDirectory;
}
for (const name of entries) {
  test(name + ': default location is unchanged; configured paths are server-owned and independent of the workspace', () => {
    for (const missing of [undefined, null, '', '  ']) assert.equal(String(load(name, missing)('/ws', File)), '/ws/agents');
    for (const configured of ['/short/tigo', 'C:\\tigo', '\\\\server\\share\\tigo']) {
      const resolve = load(name, configured);
      assert.equal(String(resolve('/ws', File)), configured);
      assert.equal(String(resolve('/another-workspace', File)), configured);
    }
  });
  test(name + ': refuses relative, drive-relative, filesystem-root and NUL destinations', () => {
    for (const invalid of ['relative', '../escape', 'C:relative', '/', 'C:\\', '\\\\server\\share', '/tmp/a\0b']) {
      assert.throws(() => load(name, invalid)('/ws', File), /assistant\.agents\.directory/, invalid);
    }
  });
}
test('all independent entry scripts use the same storage contract', () => {
  assert.ok(entries.length > 0);
  const blocks = entries.map(name => fs.readFileSync(path.join(root, 'js', name), 'utf8').split('// End shared storage contract.')[0]);
  for (const block of blocks) assert.equal(block, blocks[0]);
});
