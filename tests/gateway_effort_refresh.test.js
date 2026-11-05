const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture(efforts) {
  const stub = new Proxy(function () {}, {
    get: (_target, key) => key === Symbol.toPrimitive ? () => '' : stub,
    apply: () => stub, construct: () => stub
  });
  const s = vm.createContext({ Packages: stub, context: stub, log: stub, C8O: { agentBridge: {} } });
  vm.runInContext(fs.readFileSync('js/agent_bridge_common.js', 'utf8'), s);
  const model = 'test/reasoning-model';
  let cache = { at: 100, models: [model], efforts: { [model]: efforts } };
  const probes = [];
  s.now = () => 101;
  s.readConvertigoGatewayModelsCache = () => cache;
  s.convertigoGatewayApiKey = () => 'synthetic-test-value';
  s.fetchConvertigoGatewayModelIds = () => [model];
  s.probeGatewayModelEfforts = () => { probes.push(model); return ['low', 'high', 'max']; };
  s.convertigoGatewayModelsCacheFile = () => ({ getParentFile: () => null });
  s.ensureDirectory = () => {};
  s.writeTextFile = (_file, value) => { cache = JSON.parse(value); };
  return { s, model, probes, cache: () => cache };
}

test('explicit refresh probes a cached empty offer and publishes the recovered levels', () => {
  const f = fixture([]);
  f.s.convertigoGatewayModelNames({ refreshModelCatalog: 'true' }, '');
  assert.deepEqual(f.probes, [f.model]);
  assert.deepEqual(f.cache().efforts[f.model], ['low', 'high', 'max']);
});

test('empty efforts are retried after catalog expiry, with no probe during offline startup', () => {
  const f = fixture([]);
  f.s.convertigoGatewayModelNames({}, '');
  f.s.convertigoGatewayModelNames({ runtimePresenceOnly: 'true', refreshModelCatalog: 'true' }, '');
  assert.equal(f.probes.length, 0);
  f.s.now = () => 100 + f.s.CONVERTIGO_LLM_GATEWAY_MODELS_CACHE_MS + 1;
  f.s.convertigoGatewayModelNames({}, '');
  assert.equal(f.probes.length, 1);
});

test('ordinary catalog renewal keeps positive efforts; an explicit refresh rechecks them', () => {
  const f = fixture(['high']);
  f.s.now = () => 100 + f.s.CONVERTIGO_LLM_GATEWAY_MODELS_CACHE_MS + 1;
  f.s.convertigoGatewayModelNames({}, '');
  assert.equal(f.probes.length, 0);
  f.s.probeGatewayModelEfforts = () => { f.probes.push(f.model); return null; };
  f.s.convertigoGatewayModelNames({ refreshModelCatalog: 'true' }, '');
  assert.equal(f.probes.length, 1);
  assert.deepEqual(f.cache().efforts[f.model], ['high'], 'a transient failure retains the previous capability');
});

test('an unrelated unsupported parameter is not a negative effort capability', () => {
  const f = fixture([]);
  let body = '{"error":{"message":"max_tokens is not supported"}}';
  f.s.java = { lang: { String: function (text) { this.getBytes = () => text; this.toString = () => text; } } };
  f.s.URL = function () { return { openConnection: () => ({
    setConnectTimeout() {}, setReadTimeout() {}, setRequestMethod() {}, setDoOutput() {}, setRequestProperty() {},
    getOutputStream: () => ({ write() {}, close() {} }), getResponseCode: () => 400,
    getErrorStream: () => ({ readAllBytes: () => body, close() {} }), disconnect() {}
  }) }; };
  assert.equal(f.s.probeGatewayModelEffort({}, 'synthetic-test-value', f.model, 'high'), 'unknown');
  body = '{"error":{"message":"reasoning_effort high is not supported"}}';
  assert.equal(f.s.probeGatewayModelEffort({}, 'synthetic-test-value', f.model, 'high'), 'no');
});

test('a recovered model offer repairs a stale provider reasoning flag for the prompt footer', () => {
  const f = fixture([]);
  const provider = f.s.applyGatewayOfferToProvider({ id: 'convertigo',
    supports: { reasoning: false }, reasoningMode: 'model_bound',
    gateway: { models: ['reasoning-model'], efforts: { 'reasoning-model': ['low', 'high', 'max'] } },
    models: [] });
  assert.equal(provider.supports.reasoning, true);
  assert.equal(provider.reasoningMode, 'runtime_selectable');
  assert.deepEqual(Array.from(provider.models[0].reasoningLevels, level => level.id), ['low', 'high', 'max']);
  provider.gateway.efforts['reasoning-model'] = [];
  f.s.applyGatewayOfferToProvider(provider);
  assert.equal(provider.supports.reasoning, false);
  assert.equal(provider.models[0].reasoningLevels.length, 0);
});

test('gateway effort controls also work before the first provider cache is written', () => {
  const f = fixture(['high']);
  f.s.readPersistentProviderSettingsCache = () => null;
  const provider = f.s.hydrateProviderSettingsFromCache('', {
    id: 'convertigo', supports: { reasoning: false }, models: [],
    gateway: { models: ['reasoning-model'], efforts: { 'reasoning-model': ['high'] } }
  }, true);
  assert.equal(provider.supports.reasoning, true);
  assert.equal(provider.models[0].defaultReasoning, 'high');
});
