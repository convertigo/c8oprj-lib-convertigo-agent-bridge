// Mistral Large 4 starts on the thinking level medium when nobody chose one (measured on a CRM build: faster than high,
// same score). Its settings offer used to take the level of the catalog session's active model, GLM 5.3's high (one
// cache of test-nocode even had low), and the Assistant sends that default as reasoningEffort when nothing is saved.
// A level the user or an admin saved still wins; other models keep their defaults.
// node --test tests/ml4_default_thinking.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const stub = new Proxy(function () {}, {
  get: (_target, key) => key === Symbol.toPrimitive ? () => "" : stub,
  apply: () => stub, construct: () => stub
});
const s = vm.createContext({ Packages: stub, context: stub, log: stub, C8O: { agentBridge: {} } });
vm.runInContext(fs.readFileSync(path.join(root, "js", "agent_bridge_common.js"), "utf8"), s);

// what the gateway accepts, as probed on test-nocode and on a local Studio (agents/convertigo/gateway-models.json)
const PROBED = { "glm-5-3": ["low", "high", "max"], "mistral-large-4": ["low", "medium", "high"] };
const level = (id) => ({ id, label: id.charAt(0).toUpperCase() + id.slice(1), description: "" });

// the cached settings of test-nocode: the catalog session ran GLM 5.3 on high, Mistral Large 4 inherited it
function cachedOffer(ml4Default, efforts = PROBED) {
  return {
    id: "convertigo", supports: { reasoning: true }, reasoningMode: "runtime_selectable", defaultModel: "glm-5-3",
    gateway: { models: ["glm-5-3", "mistral-large-4"], efforts: JSON.parse(JSON.stringify(efforts)) },
    models: [
      { id: "glm-5-3", label: "glm-5-3", provider: "convertigo", defaultReasoning: "high", reasoningLevels: ["low", "high", "max"].map(level) },
      { id: "mistral-large-4", label: "mistral-large-4", provider: "convertigo", defaultReasoning: ml4Default, reasoningLevels: ["low", "medium", "high"].map(level) }
    ]
  };
}

const defaults = (provider) => Object.fromEntries(provider.models.map((model) => [model.id, model.defaultReasoning]));

test("Mistral Large 4 has a default level of its own; other models have none", () => {
  assert.equal(s.vibeModelDefaultThinking("mistral/mistral-large-4"), "medium");
  assert.equal(s.vibeModelDefaultThinking("mistral-large-4"), "medium", "the alias of the ACP catalog");
  assert.equal(s.vibeModelDefaultThinking("glm-5-3"), "");
  assert.equal(s.vibeModelDefaultThinking("mistral/zai-glm-5-3"), "");
  assert.equal(s.vibeModelDefaultThinking(""), "");
});

test("the settings offer pre-selects medium for Mistral Large 4, whatever level the catalog session sat on", () => {
  for (const inherited of ["high", "low", "", "off"]) {
    const offer = s.applyGatewayOfferToProvider(cachedOffer(inherited));
    assert.deepEqual(defaults(offer), { "glm-5-3": "high", "mistral-large-4": "medium" }, "inherited " + JSON.stringify(inherited));
  }
  // the same through the persistent cache the settings read (hydrateProviderSettingsFromCache)
  const saved = s.readPersistentProviderSettingsCache;
  s.readPersistentProviderSettingsCache = () => ({ cachedAt: 1, defaults: { model: "glm-5-3", reasoning: "high" }, models: cachedOffer("high").models,
    reasoningMode: "runtime_selectable", supports: { reasoning: true } });
  try {
    const hydrated = s.hydrateProviderSettingsFromCache("", { id: "convertigo", gateway: cachedOffer("high").gateway }, true);
    assert.deepEqual(defaults(hydrated), { "glm-5-3": "high", "mistral-large-4": "medium" });
  } finally {
    s.readPersistentProviderSettingsCache = saved;
  }
});

test("where the gateway refuses medium, Mistral Large 4 goes up to high; with unprobed efforts, its catalog levels decide", () => {
  const refused = s.applyGatewayOfferToProvider(cachedOffer("low", { "glm-5-3": PROBED["glm-5-3"], "mistral-large-4": ["low", "high"] }));
  assert.equal(defaults(refused)["mistral-large-4"], "high");
  assert.deepEqual(Array.from(refused.models[1].reasoningLevels, (l) => l.id), ["low", "high"]);
  const unprobed = s.applyGatewayOfferToProvider(cachedOffer("high", { "glm-5-3": PROBED["glm-5-3"] }));
  assert.equal(defaults(unprobed)["mistral-large-4"], "medium", "the cached catalog offers medium");
});

test("config.toml: Mistral Large 4 is declared on medium; an explicit llmGatewayThinking still applies to every model", () => {
  const offer = { gatewayModelIds: ["mistral/zai-glm-5-3", "mistral/mistral-large-4"],
    gatewayModelEfforts: { "mistral/zai-glm-5-3": PROBED["glm-5-3"], "mistral/mistral-large-4": PROBED["mistral-large-4"] } };
  assert.deepEqual(Array.from(s.vibeGatewayModelSpecs(offer, ""), (spec) => [spec.alias, spec.thinking]), [["glm-5-3", "high"], ["mistral-large-4", "medium"]]);
  assert.deepEqual(Array.from(s.vibeGatewayModelSpecs(Object.assign({ llmGatewayThinking: "high" }, offer), ""), (spec) => [spec.alias, spec.thinking]),
    [["glm-5-3", "high"], ["mistral-large-4", "high"]]);
  assert.deepEqual(Array.from(s.vibeGatewayModelSpecs(Object.assign({ llmGatewayThinking: "low" }, offer), ""), (spec) => [spec.alias, spec.thinking]),
    [["glm-5-3", "low"], ["mistral-large-4", "low"]]);
});

test("a level the user saved still wins; without one, the preference falls back on the model's default", () => {
  const provider = Object.assign(s.applyGatewayOfferToProvider(cachedOffer("high")), { ready: true });
  const saved = s.validatedAgentPreferences({ confirmed: true, provider: "convertigo", model: "mistral-large-4", reasoning: "high" }, [provider]);
  assert.equal(saved.reasoning, "high");
  const unset = s.validatedAgentPreferences({ confirmed: true, provider: "convertigo", model: "mistral-large-4", reasoning: "" }, [provider]);
  assert.equal(unset.reasoning, "", "nothing saved: the Assistant then takes the model's defaultReasoning");
  const stale = s.validatedAgentPreferences({ confirmed: true, provider: "convertigo", model: "mistral-large-4", reasoning: "max" }, [provider]);
  assert.equal(stale.reasoning, "medium", "a saved level the model does not offer falls back on its default");
});
