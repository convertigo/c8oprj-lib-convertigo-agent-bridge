// The Convertigo mode starts on Mistral Large 4 at medium when nobody chose a model (17/11/2026: it did the everyday tasks
// of an A/B against GLM 5.3 at about half the price and a third of the time per request). The default is explicit, never
// the order of the gateway list (it sorts glm-5-3 first) nor the model the last session wrote in the cached catalog or in
// config.toml. GLM 5.3 stays offered; a model or an effort the user chose is kept; the first "Continue" of the settings,
// which saved the old default (glm-5-3, high) without a choice, follows the new default. A No Code server whose
// administrators saved a model passes it as the model of every session; with nothing saved it passes none.
// node --test tests/gateway_default_model.test.js
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

const GLM = "mistral/zai-glm-5-3", ML4 = "mistral/mistral-large-4";
// what the gateway accepts, as probed on test-nocode and on a local Studio (agents/convertigo/gateway-models.json)
const EFFORTS = { [GLM]: ["low", "high", "max"], [ML4]: ["low", "medium", "high"] };
const level = (id) => ({ id, label: id, description: "" });
// values of the Bridge's context compared as plain JSON (arrays of another realm are never deep-strict-equal)
const plain = (value) => JSON.parse(JSON.stringify(value));

function withSymbol(value, run) {
  const saved = s.configuredGatewayDefaultModel;
  s.configuredGatewayDefaultModel = () => value;
  try { return run(); } finally { s.configuredGatewayDefaultModel = saved; }
}

// the Convertigo provider as a settings read answers it, from a catalog whose session last ran GLM 5.3
function convertigoProvider(aliases = ["glm-5-3", "mistral-large-4"]) {
  const all = {
    "glm-5-3": { id: "glm-5-3", label: "glm-5-3", provider: "convertigo", defaultReasoning: "high", reasoningLevels: ["low", "high", "max"].map(level) },
    "mistral-large-4": { id: "mistral-large-4", label: "mistral-large-4", provider: "convertigo", defaultReasoning: "high", reasoningLevels: ["low", "medium", "high"].map(level) },
    "devstral-3": { id: "devstral-3", label: "devstral-3", provider: "convertigo", defaultReasoning: "high", reasoningLevels: ["high"].map(level) }
  };
  const efforts = { "glm-5-3": ["low", "high", "max"], "mistral-large-4": ["low", "medium", "high"], "devstral-3": ["high"] };
  return s.applyGatewayOfferToProvider({
    id: "convertigo", ready: true, supports: { reasoning: true }, reasoningMode: "runtime_selectable", defaultModel: "glm-5-3",
    gateway: { models: aliases.slice(), efforts: Object.fromEntries(aliases.map((alias) => [alias, efforts[alias]])) },
    models: aliases.map((alias) => JSON.parse(JSON.stringify(all[alias])))
  });
}

test("the model nobody chose: Mistral Large 4 when the gateway lists it, else the first listed model", () => {
  assert.equal(s.convertigoGatewayPreferredAlias([GLM, ML4]), "mistral-large-4", "glm-5-3 is listed first");
  assert.equal(s.convertigoGatewayPreferredAlias(["glm-5-3", "mistral-large-4"]), "mistral-large-4", "aliases too");
  assert.equal(s.convertigoGatewayPreferredAlias([GLM]), "glm-5-3", "a gateway without Mistral Large 4");
  assert.equal(s.convertigoGatewayPreferredAlias(["mistral/devstral-3", GLM]), "devstral-3", "the first listed one, as before");
  assert.equal(s.convertigoGatewayPreferredAlias([]), "mistral-large-4", "nothing listed yet");
  // the operator's symbol agentbridge.gateway.default_model still replaces it, when listed
  withSymbol("glm-5-3", () => assert.equal(s.convertigoGatewayPreferredAlias([GLM, ML4]), "glm-5-3"));
  withSymbol(GLM, () => assert.equal(s.convertigoGatewayPreferredAlias([GLM, ML4]), "glm-5-3", "a full gateway name"));
  withSymbol("retired-model", () => assert.equal(s.convertigoGatewayPreferredAlias([GLM, ML4]), "mistral-large-4"));
});

test("a session runs the model it was asked for when listed, else the default", () => {
  assert.equal(s.convertigoGatewayDefaultAlias({}, [GLM, ML4]), "mistral-large-4");
  assert.equal(s.convertigoGatewayDefaultAlias({ model: "glm-5-3" }, [GLM, ML4]), "glm-5-3", "the user's or the administrators' choice");
  assert.equal(s.convertigoGatewayDefaultAlias({ agentModel: "mistral-large-4" }, [GLM, ML4]), "mistral-large-4");
  assert.equal(s.convertigoGatewayDefaultAlias({ model: "retired-model" }, [GLM, ML4]), "mistral-large-4");
  assert.equal(s.convertigoGatewayDefaultAlias({ model: "mistral-large-4" }, [GLM]), "glm-5-3", "not listed: the first listed model");
});

test("with no gateway list at all the built-in offer is the default model", () => {
  assert.equal(s.CONVERTIGO_LLM_GATEWAY_MODEL, ML4);
  const specs = s.vibeGatewayModelSpecs({ dryRun: "true", runtimePresenceOnly: "true" }, "");
  assert.deepEqual(plain(specs.map((spec) => spec.alias)), ["mistral-large-4"]);
  assert.equal(specs[0].activeModel, "mistral-large-4");
});

test("the Vibe config of a session: Mistral Large 4 at medium unless a model was asked for; GLM 5.3 stays declared", () => {
  const options = { vibeProfile: "convertigo", gatewayModelIds: [GLM, ML4], gatewayModelEfforts: EFFORTS };
  const specs = s.vibeGatewayModelSpecs(options, "");
  assert.deepEqual(plain(specs.map((spec) => [spec.alias, spec.activeModel, spec.thinking])),
    [["glm-5-3", "mistral-large-4", "high"], ["mistral-large-4", "mistral-large-4", "medium"]]);
  let config = "";
  const saved = { writeTextFile: s.writeTextFile, ensureDirectory: s.ensureDirectory };
  s.writeTextFile = (_file, text) => { config = String(text); };
  s.ensureDirectory = () => {};
  try {
    // agent_vibe_start writes the home with no model and sets the session's model over ACP
    s.writeLocalVibeConfig("/managed/home", "http://localhost:18080/convertigo/api/mcp", "", options);
    assert.match(config, /^active_model = "mistral-large-4"$/m);
    assert.match(config, /name = "mistral\/mistral-large-4"[^\[]*thinking = "medium"/);
    assert.match(config, /name = "mistral\/zai-glm-5-3"[^\[]*alias = "glm-5-3"/, "GLM 5.3 stays selectable");
    s.writeLocalVibeConfig("/managed/home", "http://localhost:18080/convertigo/api/mcp", "glm-5-3", options);
    assert.match(config, /^active_model = "glm-5-3"$/m, "a home written for GLM 5.3");
    // a gateway list without Mistral Large 4: its first model, as before
    s.writeLocalVibeConfig("/managed/home", "http://localhost:18080/convertigo/api/mcp", "", { vibeProfile: "convertigo", gatewayModelIds: [GLM], gatewayModelEfforts: EFFORTS });
    assert.match(config, /^active_model = "glm-5-3"$/m);
  } finally {
    Object.assign(s, saved);
  }
});

test("the settings offer: Mistral Large 4 at medium by default, whatever model the catalog session last ran", () => {
  const offer = convertigoProvider();
  assert.equal(offer.defaultModel, "mistral-large-4");
  assert.equal(s.providerDefaultReasoning(offer), "medium");
  assert.deepEqual(plain(offer.models.map((model) => model.id)), ["glm-5-3", "mistral-large-4"], "GLM 5.3 stays in the picker");
  assert.equal(convertigoProvider(["glm-5-3"]).defaultModel, "glm-5-3", "a gateway without Mistral Large 4");
  assert.equal(convertigoProvider(["devstral-3", "glm-5-3"]).defaultModel, "devstral-3");
  withSymbol("glm-5-3", () => assert.equal(convertigoProvider().defaultModel, "glm-5-3", "the operator's symbol"));
  // through the persistent cache a session wrote with its own model (glm-5-3, high)
  const saved = s.readPersistentProviderSettingsCache;
  s.readPersistentProviderSettingsCache = () => ({ cachedAt: 1, defaults: { model: "glm-5-3", reasoning: "high" },
    models: convertigoProvider().models, reasoningMode: "runtime_selectable", supports: { reasoning: true } });
  try {
    const hydrated = s.hydrateProviderSettingsFromCache("", { id: "convertigo", ready: true,
      gateway: { models: ["glm-5-3", "mistral-large-4"], efforts: { "glm-5-3": ["low", "high", "max"], "mistral-large-4": ["low", "medium", "high"] } } }, true);
    assert.equal(hydrated.defaultModel, "mistral-large-4");
    assert.equal(s.providerDefaultReasoning(hydrated), "medium");
    assert.equal(s.compactProviderSettingsCache(hydrated).defaults.model, "mistral-large-4");
  } finally {
    s.readPersistentProviderSettingsCache = saved;
  }
});

test("a saved preference: the old implicit default follows the new one, a choice is kept", () => {
  const providers = [convertigoProvider(), { id: "codex", ready: true, defaultModel: "gpt-current", supports: { reasoning: true },
    models: [{ id: "gpt-current", defaultReasoning: "medium", reasoningLevels: ["low", "medium", "high"].map(level) }, { id: "gpt-other", defaultReasoning: "medium", reasoningLevels: ["medium"].map(level) }] }];
  const read = (saved) => {
    const p = s.validatedAgentPreferences(Object.assign({ confirmed: true, provider: "convertigo", updatedAt: 1 }, saved), providers);
    return [p.model, p.reasoning, p.modelChosen];
  };
  // the first "Continue" of the settings saved what they showed: GLM 5.3 at high (Studio_8.4_repro_tigo, 12/11)
  assert.deepEqual(read({ model: "glm-5-3", reasoning: "high" }), ["mistral-large-4", "medium", false]);
  assert.deepEqual(read({ model: "glm-5-3", reasoning: "" }), ["mistral-large-4", "medium", false]);
  // anything else saved before modelChosen existed is a choice
  assert.deepEqual(read({ model: "glm-5-3", reasoning: "max" }), ["glm-5-3", "max", true]);
  assert.deepEqual(read({ model: "mistral-large-4", reasoning: "high" }), ["mistral-large-4", "high", true]);
  assert.deepEqual(read({ provider: "codex", model: "gpt-other", reasoning: "medium" }), ["gpt-other", "medium", true]);
  // saved with the flag
  assert.deepEqual(read({ model: "glm-5-3", reasoning: "high", modelChosen: true }), ["glm-5-3", "high", true]);
  assert.deepEqual(read({ model: "glm-5-3", reasoning: "high", modelChosen: false }), ["mistral-large-4", "medium", false]);
  // a chosen model the gateway no longer offers: the default, not the first model
  assert.deepEqual(read({ model: "retired-model", reasoning: "high", modelChosen: true }), ["mistral-large-4", "medium", false]);
  // a provider whose default is not Mistral Large 4 (a gateway without it): the old pair is still no choice
  assert.deepEqual(s.validatedAgentPreferences({ confirmed: true, provider: "convertigo", model: "glm-5-3", reasoning: "high" },
    [convertigoProvider(["devstral-3", "glm-5-3"])]).model, "devstral-3");
});

test("saving a preference: a model or an effort other than the default is a choice; the default is none", () => {
  const providers = [convertigoProvider()];
  const chosen = (requested, stored = null) => s.requestedAgentPreferenceModelChosen(Object.assign({ provider: "convertigo" }, requested), stored, providers);
  assert.equal(chosen({ model: "glm-5-3", reasoning: "high" }), true, "GLM 5.3 picked in the settings");
  assert.equal(chosen({ model: "mistral-large-4", reasoning: "high" }), true, "another effort for the default model");
  assert.equal(chosen({ model: "mistral-large-4", reasoning: "medium" }), false, "Continue on what the screen showed");
  assert.equal(chosen({ model: "mistral-large-4", reasoning: "" }), false);
  // saving again what was chosen keeps the choice, even at the default values
  assert.equal(chosen({ model: "mistral-large-4", reasoning: "medium" }, { provider: "convertigo", model: "mistral-large-4", reasoning: "medium", modelChosen: true }), true);
  assert.equal(chosen({ model: "mistral-large-4", reasoning: "medium" }, { provider: "convertigo", model: "glm-5-3", reasoning: "high", modelChosen: true }), false,
    "back on the default values after a choice of GLM 5.3");
  assert.equal(chosen({ model: "glm-5-3", reasoning: "high" }, { provider: "convertigo", model: "glm-5-3", reasoning: "high" }), true,
    "GLM 5.3 shown and saved again is not the default any more");
  // other providers: their default follows their last session, so whatever is saved stays a choice (as before)
  assert.equal(s.requestedAgentPreferenceModelChosen({ provider: "codex", model: "gpt-current", reasoning: "medium" }, null, providers), true);
  // an effort the model refuses becomes its default before the choice is read: the default is still none
  const corrected = s.savedAgentPreferences({ confirmed: true, provider: "convertigo", model: "mistral-large-4", reasoning: "max" }, null, providers);
  assert.deepEqual([corrected.model, corrected.reasoning, corrected.modelChosen], ["mistral-large-4", "medium", false]);
  const glm = s.savedAgentPreferences({ confirmed: true, provider: "convertigo", model: "glm-5-3", reasoning: "high" }, null, providers);
  assert.deepEqual([glm.model, glm.reasoning, glm.modelChosen], ["glm-5-3", "high", true]);
  const again = s.savedAgentPreferences({ confirmed: true, provider: "convertigo", model: "glm-5-3", reasoning: "high" }, glm, providers);
  assert.equal(again.modelChosen, true);
  assert.equal(s.savedAgentPreferences({ confirmed: true, provider: "missing", model: "x" }, null, providers), null);
  // the saved record, then the next read
  const saved = s.validatedAgentPreferences({ confirmed: true, provider: "convertigo", model: "glm-5-3", reasoning: "high",
    modelChosen: chosen({ model: "glm-5-3", reasoning: "high" }) }, providers);
  assert.equal(saved.modelChosen, true);
  assert.deepEqual([saved.model, saved.reasoning], ["glm-5-3", "high"]);
  const fresh = s.validatedAgentPreferences({ confirmed: true, provider: "convertigo", model: "mistral-large-4", reasoning: "medium",
    modelChosen: chosen({ model: "mistral-large-4", reasoning: "medium" }) }, providers);
  assert.deepEqual([fresh.model, fresh.reasoning, fresh.modelChosen], ["mistral-large-4", "medium", false]);
});

test("No Code: a server model saved by the administrators runs; with none saved the default does", () => {
  // what lib_ConvertigoAssistant's withNoCodeServerSettings passes: assistant.nocode.model / reasoning, "" when not set
  const options = (model, reasoning) => ({ vibeProfile: "convertigo", gatewayModelIds: [GLM, ML4], gatewayModelEfforts: EFFORTS,
    model, agentModel: model, reasoningEffort: reasoning });
  assert.equal(s.vibeGatewayModelSpecs(options("glm-5-3", "high"), "")[0].activeModel, "glm-5-3");
  assert.equal(s.vibeGatewayModelSpecs(options("mistral-large-4", "high"), "")[0].activeModel, "mistral-large-4");
  const none = s.vibeGatewayModelSpecs(options("", ""), "");
  assert.equal(none[0].activeModel, "mistral-large-4");
  assert.equal(none.find((spec) => spec.alias === "mistral-large-4").thinking, "medium");
});

test("the default effort of a gateway model never follows the level the catalog session sat on", () => {
  const provider = convertigoProvider();
  // a catalog written by a session that ran both models at low
  const offer = s.applyGatewayOfferToProvider({ id: "convertigo", ready: true, supports: { reasoning: true }, defaultModel: "glm-5-3",
    gateway: { models: ["glm-5-3", "mistral-large-4"], efforts: { "glm-5-3": ["low", "high", "max"], "mistral-large-4": ["low", "medium", "high"] } },
    models: plain(provider.models).map((model) => Object.assign(model, { defaultReasoning: "low" })) });
  assert.deepEqual(plain(offer.models.map((model) => [model.id, model.defaultReasoning])), [["glm-5-3", "high"], ["mistral-large-4", "medium"]]);
});

test("a Convertigo session started without any model asks for the default model at its default effort", () => {
  const saved = { readPersistentAgentPreferences: s.readPersistentAgentPreferences, resolveWorkspaceRoot: s.resolveWorkspaceRoot,
    convertigoGatewayModelNames: s.convertigoGatewayModelNames, readConvertigoGatewayModelsCache: s.readConvertigoGatewayModelsCache };
  let stored = null, listed = [GLM, ML4];
  s.readPersistentAgentPreferences = () => stored;
  s.resolveWorkspaceRoot = () => "/workspace";
  s.convertigoGatewayModelNames = (options) => { assert.equal(options.runtimePresenceOnly, "true", "the cached list, no gateway call"); return listed; };
  s.readConvertigoGatewayModelsCache = () => ({ models: listed, at: 1, efforts: EFFORTS, effortsAt: {} });
  const start = (options) => plain(s.withConvertigoSessionModel(Object.assign({ vibeProfile: "convertigo", userId: "studio" }, options)));
  try {
    // an existing home may keep active_model = glm-5-3: the session is asked for the default instead
    assert.deepEqual([start({}).model, start({}).reasoningEffort], ["mistral-large-4", "medium"]);
    // No Code with no model saved by the administrators (the Assistant passes model ""), and a user's own effort
    assert.deepEqual([start({ userId: "alice@example.com" }).model, start({ userId: "alice@example.com" }).reasoningEffort], ["mistral-large-4", "medium"]);
    assert.equal(start({ userId: "alice@example.com", reasoningEffort: "low" }).reasoningEffort, "low");
    // the administrators' model, the user's saved choice and a model asked for are kept
    assert.equal(start({ userId: "alice@example.com", model: "glm-5-3", reasoningEffort: "high" }).model, "glm-5-3");
    stored = { confirmed: true, provider: "convertigo", model: "glm-5-3", reasoning: "high", modelChosen: true };
    assert.deepEqual([start({}).model, start({}).reasoningEffort], ["glm-5-3", "high"]);
    assert.equal(start({ userId: "alice@example.com" }).model, "mistral-large-4", "No Code ignores a user's own saved preference");
    stored = null;
    assert.equal(start({ settingsProbe: "true" }).model, undefined, "a settings probe reads the catalog only");
    assert.equal(start({ vibeProfile: "mistral" }).model, undefined, "the Vibe profile is not concerned");
    listed = [GLM];
    assert.deepEqual([start({}).model, start({}).reasoningEffort], ["glm-5-3", "high"], "a gateway without Mistral Large 4");
  } finally {
    Object.assign(s, saved);
  }
});

test("a Convertigo session started without a model runs the user's saved choice, else the default; never on No Code", () => {
  const saved = { readPersistentAgentPreferences: s.readPersistentAgentPreferences, resolveWorkspaceRoot: s.resolveWorkspaceRoot };
  let stored = null;
  s.readPersistentAgentPreferences = () => stored;
  s.resolveWorkspaceRoot = () => "/workspace";
  const start = (options) => plain(s.withSavedConvertigoChoice(Object.assign({ vibeProfile: "convertigo", userId: "studio" }, options)));
  try {
    stored = { confirmed: true, provider: "convertigo", model: "glm-5-3", reasoning: "high", modelChosen: true };
    assert.equal(start({}).model, "glm-5-3", "the saved choice");
    assert.equal(start({}).reasoningEffort, "high");
    assert.equal(start({ reasoningEffort: "max" }).reasoningEffort, "max", "an effort asked for stays");
    assert.equal(start({ model: "mistral-large-4" }).model, "mistral-large-4", "a model asked for wins");
    assert.equal(start({ userId: "alice@example.com" }).model, undefined, "No Code (any user but studio): the administrators decide");
    assert.equal(start({ settingsProbe: "true" }).model, undefined, "a settings probe reads the catalog only");
    assert.equal(start({ vibeProfile: "mistral" }).model, undefined, "the Vibe profile is not concerned");
    stored = { confirmed: true, provider: "convertigo", model: "glm-5-3", reasoning: "high" };
    assert.equal(start({}).model, undefined, "the old implicit default is no choice: the default runs");
    stored = { confirmed: true, provider: "convertigo", model: "mistral-large-4", reasoning: "medium", modelChosen: false };
    assert.equal(start({}).model, undefined);
    stored = { confirmed: true, provider: "codex", model: "gpt-current", reasoning: "high", modelChosen: true };
    assert.equal(start({}).model, undefined, "another provider's choice");
    stored = null;
    assert.equal(start({}).model, undefined, "nothing saved");
  } finally {
    Object.assign(s, saved);
  }
});
