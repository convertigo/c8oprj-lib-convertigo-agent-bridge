const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function scope() {
  const javaStub = new Proxy(function () {}, {
    get(_target, key) { return key === Symbol.toPrimitive ? () => '' : javaStub; },
    apply() { return javaStub; }, construct() { return javaStub; }
  });
  const s = vm.createContext({ Packages: javaStub, context: javaStub, log: javaStub, C8O: { agentBridge: {} } });
  vm.runInContext(fs.readFileSync('js/agent_bridge_common.js', 'utf8'), s);
  return s;
}

test('loopback bypass survives replaced exclusions, disabled proxy and DIRECT', () => {
  const s = scope();
  for (const settings of [{}, { enabled: false }, { enabled: true, direct: true }, {
    enabled: true, host: 'proxy.example', port: 3128, noProxy: 'intranet.example'
  }]) {
    const env = s.proxyEnvironmentFromSettings(settings);
    for (const host of ['localhost', '127.0.0.1', '::1']) assert.ok(env.NO_PROXY.split(',').includes(host));
    assert.equal(env.no_proxy, env.NO_PROXY);
    if (!settings.host) assert.equal(env.HTTPS_PROXY, undefined);
    else assert.ok(env.NO_PROXY.includes('intranet.example'));
  }
});

test('failed PAC resolution stops before a child process starts', () => {
  const s = scope();
  s.Engine = { theApp: { proxyManager: {
    isEnabled: () => true, proxyMode: 'auto', proxyMethod: 'anonymous',
    getProxyUser: () => '', getProxyPassword: () => '', getBypassDomains: () => [],
    getPacInfos: () => { throw new Error('malformed PAC response'); }
  } } };
  assert.throws(() => s.applyEngineProxyEnvironment({ put() { assert.fail('no environment on PAC failure'); } }, 'https://pypi.org'), /Unable to resolve.*proxy settings.*auto.*PAC/);
  let started = false;
  s.File = { createTempFile: () => ({ delete() {} }) };
  s.ProcessBuilder = function () { return { environment: () => ({}), start() { started = true; } }; };
  s.toJavaList = a => a;
  const result = s.runCommandCaptured(['python', '-m', 'pip'], { proxyTargetUrl: 'https://pypi.org' });
  assert.equal(result.ok, false);
  assert.match(result.error, /Unable to resolve.*PAC/);
  assert.equal(started, false);
});

test('gateway metadata uses the engine proxy client and closes responses on success or refusal', () => {
  const s = scope();
  let status = 200, executed = 0, closed = 0, streamClosed = 0, configured = 0;
  const config = new Proxy({}, { get: (_t, k) => k === 'build' ? () => config : () => config });
  s.Packages = { org: { apache: { http: { client: {
    methods: { HttpGet: function (url) { this.url = url; this.headers = {}; this.setHeader = (k, v) => { this.headers[k] = v; }; this.setConfig = () => {}; } },
    config: { RequestConfig: { custom: () => config } }
  } } } } };
  s.java = { lang: { String: function (text) { return new String(text); } } };
  s.configureHttpRequestProxy = (get, _config, url) => {
    configured++;
    assert.equal(url, 'https://llm.convertigo.com/v1/models');
    assert.equal(get.headers.Authorization, 'Bearer synthetic-invalid-key');
  };
  s.Engine = { theApp: { httpClient4: { execute(get) {
    executed++;
    assert.equal(get.url, 'https://llm.convertigo.com/v1/models');
    return { getStatusLine: () => ({ getStatusCode: () => status }), close: () => { closed++; },
      getEntity: () => ({ getContent: () => ({ readAllBytes: () => '{"data":[{"id":"test/model"}]}', close: () => { streamClosed++; } }) }) };
  } } } };
  assert.deepEqual(Array.from(s.fetchConvertigoGatewayModelIds({}, 'synthetic-invalid-key')), ['test/model']);
  assert.equal(streamClosed, 1);
  for (status of [401, 403, 407, 500]) {
    assert.equal(s.fetchConvertigoGatewayModelIds({}, 'synthetic-invalid-key').length, 0);
    assert.equal(s.convertigoGatewayKeyRejected, status === 401 || status === 403);
  }
  assert.equal(executed, 5); assert.equal(configured, 5); assert.equal(closed, 5);
  s.Engine.theApp.httpClient4.execute = () => { throw new Error('proxy unreachable'); };
  assert.equal(s.fetchConvertigoGatewayModelIds({}, 'synthetic-invalid-key').length, 0);
});

test('both managed Vibe profiles retain system trust through rewrites and migrations', () => {
  const s = scope();
  let content;
  s.ensureDirectory = () => {};
  s.writeTextFile = (_file, text) => { content = String(text); };
  for (const options of [{}, { vibeProfile: 'convertigo', gatewayModelIds: ['mistral/zai-glm-5-3'] }]) {
    for (let i = 0; i < 2; i++) {
      s.writeLocalVibeConfig('/managed/test-home', 'http://localhost:18080/convertigo/api/mcp', 'glm-5-3', options);
      assert.match(content.split('[[providers]]')[0], /^enable_system_trust_store = true$/m);
      assert.equal((content.match(/^enable_system_trust_store = /gm) || []).length, 1);
      assert.match(s.migrateManagedVibeModelPresets(content).text, /^enable_system_trust_store = true$/m);
    }
  }
});

test('managed installation requests the qualified Vibe version', () => {
  const source = fs.readFileSync('js/agent_bridge_vibe.js', 'utf8');
  assert.match(source, /"pip", "install", "--upgrade", "mistral-vibe==3\.1\.0"/);
  assert.doesNotMatch(source, /"pip", "install", "--upgrade", "mistral-vibe"/);
});
