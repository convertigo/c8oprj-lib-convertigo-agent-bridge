const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');

const cache = path.join(os.homedir(), '.gradle/caches/modules-2/files-2.1/org.mozilla/rhino/1.9.2');
const cached = fs.existsSync(cache) ? fs.readdirSync(cache).map(dir => path.join(cache, dir, 'rhino-1.9.2.jar')).find(p => fs.existsSync(p)) : null;
const jar = process.env.RHINO_TEST_JAR || cached;
const binary = name => process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', name + (process.platform === 'win32' ? '.exe' : '')) : name;

test('the proxy capability check sees a native Java static method in real Rhino', {skip: !jar && 'Set RHINO_TEST_JAR and a JDK to run the native API check'}, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-api-test-'));
  try {
    const source = fs.readFileSync(path.join(__dirname, '../js/agent_bridge_common.js'), 'utf8');
    const helper = source.match(/function engineProcessProxyAvailable\(\) \{[\s\S]*?\n  \}/);
    assert.ok(helper);
    const script = path.join(temp, 'helper.js');
    fs.writeFileSync(script, helper[0]);
    const compiled = spawnSync(binary('javac'), ['-cp', jar, '-d', temp, path.join(__dirname, 'ProxyApiDetectionProbe.java')], {encoding:'utf8', timeout:30000});
    assert.equal(compiled.status, 0, compiled.stderr || String(compiled.error));
    const result = spawnSync(binary('java'), ['-cp', jar + path.delimiter + temp, 'ProxyApiDetectionProbe', script], {encoding:'utf8', timeout:30000});
    assert.equal(result.status, 0, result.stderr || String(result.error));
    assert.match(result.stdout, /PASS native API discovery and legacy fallback/);
  } finally {
    fs.rmSync(temp, {recursive:true, force:true});
  }
});
