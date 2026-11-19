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

test('an older engine requires the proxy update before starting a PAC child process', () => {
  const s = scope();
  s.Engine = { theApp: { proxyManager: {
    isEnabled: () => true, proxyMode: 'auto', proxyMethod: 'anonymous',
    getProxyUser: () => '', getProxyPassword: () => '', getBypassDomains: () => [],
    getPacInfos: () => { throw new Error('malformed PAC response'); }
  } } };
  assert.throws(() => s.applyEngineProxyEnvironment({ put() { assert.fail('no environment on PAC failure'); } }, 'https://pypi.org'), /PAC proxy support.*updated Convertigo engine/);
  let started = false;
  s.File = { createTempFile: () => ({ delete() {} }) };
  s.ProcessBuilder = function () { return { environment: () => ({}), start() { started = true; } }; };
  s.toJavaList = a => a;
  const result = s.runCommandCaptured(['python', '-m', 'pip'], { proxyTargetUrl: 'https://pypi.org' });
  assert.equal(result.ok, false);
  assert.match(result.error, /PAC proxy support.*updated Convertigo engine/);
  assert.equal(started, false);
});

test('the engine relay environment replaces inherited installer proxies and keeps loopback direct', () => {
  const s = scope();
  s.engineProcessProxyAvailable = () => true;
  const values = new Map([['HTTP_PROXY', 'http://old.invalid:8080'], ['PIP_PROXY', 'http://old.invalid:8080']]);
  const env = { put: (k, v) => values.set(k, v), get: k => values.get(k) || null };
  let calls = 0;
  s.ProcessUtils = { configureProxyEnvironment(e) {
    calls++;
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) e.put(key, 'http://127.0.0.1:19080');
    e.put('NO_PROXY', 'internal.example'); e.put('NODE_USE_ENV_PROXY', '1');
  } };
  s.Engine = {theApp: {proxyManager: {isEnabled: () => true}}};
  s.applyEngineProxyEnvironment(env, 'https://registry.npmjs.org');
  assert.equal(calls, 1);
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'npm_config_proxy', 'npm_config_https_proxy', 'NPM_CONFIG_PROXY', 'NPM_CONFIG_HTTPS_PROXY', 'PIP_PROXY']) assert.equal(values.get(key), 'http://127.0.0.1:19080');
  assert.equal(values.get('NODE_USE_ENV_PROXY'), '1');
  for (const host of ['internal.example', 'localhost', '127.0.0.1', '::1']) assert.ok(values.get('NO_PROXY').split(',').includes(host));
});

test('the optional engine proxy API is detected by its exact public method', () => {
  const s = scope();
  let methods = [{getName: () => 'configureProxyEnvironment', getParameterTypes: () => [{getName: () => 'java.util.Map'}]}];
  s.Packages = {java:{lang:{Class:{forName(name) {
    assert.equal(name, 'com.twinsoft.convertigo.engine.util.ProcessUtils');
    return {getMethods: () => methods};
  }}}}};
  assert.equal(s.engineProcessProxyAvailable(), true);
  methods = [{getName: () => 'configureProxyEnvironment', getParameterTypes: () => []}];
  assert.equal(s.engineProcessProxyAvailable(), false);
  methods = [];
  assert.equal(s.engineProcessProxyAvailable(), false);
});

test('modern HTTP requests let the engine select and authenticate the proxy in every mode', () => {
  const s = scope(); s.engineProcessProxyAvailable = () => true;
  s.engineProxySettings = () => assert.fail('HTTP must not resolve a subprocess proxy');
  for (const mode of ['auto', 'manual', 'off']) for (const method of ['anonymous', 'basic', 'ntlm']) {
    s.Engine = {theApp: {proxyManager: {proxyMode: mode, proxyMethod: method}}};
    const result = s.configureHttpRequestProxy({setHeader() { assert.fail('no library proxy headers'); }}, {setProxy() {assert.fail('no explicit proxy');}}, 'https://models.example/v1/models');
    assert.equal(result.mode, 'engine');
  }
});

test('a relay setup failure never falls back to the old proxy or starts a child', () => {
  const s = scope(); s.engineProcessProxyAvailable = () => true;
  s.ProcessUtils = { configureProxyEnvironment() {throw new Error('relay unavailable');} };
  s.engineProxySettings = () => assert.fail('no legacy fallback after a relay error');
  let started = false;
  s.ProcessBuilder = function () { return { environment: () => ({}), start() { started = true; } }; };
  s.toJavaList = a => a;
  const result = s.runCommand(['python', '-m', 'pip'], {});
  assert.equal(result.ok, false); assert.match(result.error, /relay unavailable/); assert.equal(started, false);
});

test('every caller merges its runtime environment before applying the engine proxy', () => {
  const common = fs.readFileSync('js/agent_bridge_common.js', 'utf8');
  for (const name of ['runCommand', 'runCommandCaptured', 'runProcessBuilder']) {
    const start = common.indexOf('  function ' + name + '(');
    const body = common.slice(start, common.indexOf('\n  function ', start + 4));
    assert.ok(body.indexOf('envObjectToMap(pb.environment(), options.env)') < body.indexOf('applyEngineProxyEnvironment(pb.environment()'), name);
  }
  for (const file of ['agent_bridge_vibe.js', 'agent_bridge_claude.js', 'agent_bridge_codex.js']) {
    const source = fs.readFileSync('js/' + file, 'utf8');
    const at = source.indexOf('    var pb = new ProcessBuilder');
    const body = source.slice(at, source.indexOf('pb.start()', at));
    assert.ok(body.indexOf('envObjectToMap(pb.environment()') < body.indexOf('applyEngineProxyEnvironment(pb.environment()'), file);
  }
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
  assert.match(source, /"pip", "install", "--upgrade", managedVibePackageRequirement\(\)/);
  assert.equal(scope().managedVibePackageRequirement(), "mistral-vibe==3.1.0");
  assert.doesNotMatch(source, /"pip", "install", "--upgrade", "mistral-vibe"/);
});
