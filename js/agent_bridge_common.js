// Common runtime, process registry, event buffer and shared helpers.
// Loaded by vibe_agent_bridge.js inside one Rhino scope.
  var REGISTRY_KEY = "lib_ConvertigoAgentBridge.agentProcessRegistry.v1";
  var SESSION_HANDLE_ATTR = "lib_ConvertigoAgentBridge.currentHandle";
  var SESSION_CONVERSATION_ATTR = "lib_ConvertigoAgentBridge.currentConversationId";
  var FALLBACK_MCP_PATH = "/api/mcp";
  var FALLBACK_FLOW_MCP_PATH = "/api/flow-mcp";
  var DEFAULT_TTL_SECONDS = 3600;
  var RUNTIME_UPDATE_CACHE_KEY = "lib_ConvertigoAgentBridge.runtimeUpdateCache.v1";
  var RUNTIME_UPDATE_CACHE_FILE = "runtime-update-checks.json";
  var DEFAULT_RUNTIME_UPDATE_CACHE_MS = 21600000;
  var STORAGE_CLEANUP_FILE = "storage-cleanup.json";
  var DEFAULT_STORAGE_CLEANUP_INTERVAL_MS = 21600000;
  var DEFAULT_STORAGE_ORPHAN_GRACE_MS = 86400000;
  var DEFAULT_EVENT_LIMIT = 100;
  var MAX_EVENT_LIMIT = 500;
  var MAX_EVENT_BUFFER = 5000;
  var NOCODE_MCP_TOKEN_ENV = "C8O_NOCODE_MCP_TOKEN";
  var MCP_TOKEN_ENV = "CONVERTIGO_MCP_TOKEN";
  var MCP_GUIDANCE_VERSION = "2026-09-04.vibe-serial-transport-v1";
  var MCP_CATALOG_PROJECT = "lib_ConvertigoMCP";
  // GLM 5.2 routed through the Mistral account has no vision: Mistral answers
  // "Image input is not enabled for this model" (400, code 3051) when an image
  // block is sent. Verified on 2026-09-14; flip only after a new live check.
  var VIBE_GLM_SUPPORTS_IMAGES = false;
  // "Convertigo" agent mode: Vibe talks to the Convertigo LiteLLM gateway with a
  // per-user virtual key instead of a personal Mistral account.
  var CONVERTIGO_LLM_GATEWAY_URL = "https://llm.convertigo.com/v1";
  // Fallback only: the offer normally comes from the gateway (GET /models).
  var CONVERTIGO_LLM_GATEWAY_MODEL = "mistral/zai-glm-5-3";
  var CONVERTIGO_LLM_GATEWAY_ALIAS = "glm-5-3";
  var CONVERTIGO_LLM_API_KEY_ENV = "CONVERTIGO_LLM_API_KEY";
  // The gateway lets reasoning_effort through for GLM 5.2 (allowed_openai_params on the
  // model); think by default, llmGatewayThinking or the ACP reasoning effort override it.
  var CONVERTIGO_LLM_GATEWAY_THINKING = "medium";

  // include() shares the sequence scope: never shadow the public vibeProfile input.
  function resolveVibeProfile(options) {
    options = options || {};
    var raw = trim(options.vibeProfile || options.gatewayProfile || options.agentMode).toLowerCase();
    if (!raw.length) {
      var provider = trim(options.provider || options.agent || options.agentProvider).toLowerCase();
      raw = provider === "convertigo" ? "convertigo" : "";
    }
    return raw === "convertigo" || raw === "gateway" || raw === "convertigo-gateway" ? "convertigo" : "mistral";
  }

  function isConvertigoGatewayProfile(options) {
    return resolveVibeProfile(options) === "convertigo";
  }

  function withVibeProfile(options, profile) {
    var copy = {};
    for (var key in (options || {})) {
      if (Object.prototype.hasOwnProperty.call(options, key)) {
        copy[key] = options[key];
      }
    }
    copy.vibeProfile = profile;
    if (profile === "convertigo" && normalizeProvider(copy.provider || "vibe") === "convertigo") {
      copy.provider = "vibe";
    }
    return copy;
  }

  function convertigoGatewayUrl(options) {
    var url = trim(options && (options.llmGatewayUrl || options.gatewayUrl)) || CONVERTIGO_LLM_GATEWAY_URL;
    return url.replace(/\/+$/, "");
  }

  function convertigoGatewayModel(options) {
    return trim(options && (options.llmGatewayModel || options.gatewayModel)) || CONVERTIGO_LLM_GATEWAY_MODEL;
  }

  function convertigoGatewayThinking(options) {
    var value = trim(options && (options.llmGatewayThinking || options.gatewayThinking)).toLowerCase();
    if (value === "off" || value === "none" || value === "false") {
      return "";
    }
    if (value === "low" || value === "medium" || value === "high") {
      return value;
    }
    return CONVERTIGO_LLM_GATEWAY_THINKING === "off" ? "" : CONVERTIGO_LLM_GATEWAY_THINKING;
  }

  // The Convertigo mode offers whatever the gateway exposes to the user's key (GET /models),
  // so declaring or retiring a model in LiteLLM needs no Bridge release. Aliases drop the
  // upstream provider path and the vendor prefix: mistral/zai-glm-5-3 -> glm-5-3.
  var CONVERTIGO_LLM_GATEWAY_MODELS_CACHE_MS = 5 * 60 * 1000;
  var CONVERTIGO_LLM_GATEWAY_DEFAULT_MODEL_SYMBOL = "agentbridge.gateway.default_model";

  function gatewayModelAlias(name) {
    var text = trim(name);
    var slash = text.lastIndexOf("/");
    if (slash >= 0) {
      text = text.substring(slash + 1);
    }
    text = text.replace(/^zai-/i, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    return text.length ? text : CONVERTIGO_LLM_GATEWAY_ALIAS;
  }

  function compareGatewayModelNames(left, right) {
    // Newest first: numeric chunks compare as numbers, so glm-5-10 sorts before glm-5-3.
    var a = gatewayModelAlias(left).split(/(\d+)/), b = gatewayModelAlias(right).split(/(\d+)/);
    for (var i = 0; i < Math.max(a.length, b.length); i++) {
      var x = a[i] === undefined ? "" : a[i], y = b[i] === undefined ? "" : b[i];
      if (x === y) { continue; }
      if (/^\d+$/.test(x) && /^\d+$/.test(y)) { return Number(y) - Number(x); }
      return x < y ? -1 : 1;
    }
    return 0;
  }

  function normalizeGatewayModelIds(value) {
    var list = value;
    if (list && typeof list === "object" && !Array.isArray(list)) { list = String(list); }
    if (typeof list === "string") { list = list.split(/[\s,;]+/); }
    if (!Array.isArray(list)) { return []; }
    var seen = {}, names = [];
    for (var i = 0; i < list.length; i++) {
      var name = trim(list[i]);
      if (name.length && !seen[name] && /^[A-Za-z0-9._\/:-]+$/.test(name)) {
        seen[name] = true;
        names.push(name);
      }
    }
    return names.sort(compareGatewayModelNames);
  }

  function convertigoGatewayApiKey(options, vibeHome) {
    var explicit = trim(options && (options.gatewayApiKey || options.llmGatewayApiKey));
    if (explicit.length) { return explicit; }
    return resolveConvertigoGatewayKey(options, vibeHome).key;
  }

  function convertigoGatewayModelsCacheFile(options) {
    try {
      var keyFile = convertigoGatewayKeyFile(options);
      return keyFile === null ? null : new File(keyFile.getParentFile(), "gateway-models.json");
    } catch (_ignoreGatewayCacheFile) {
      return null;
    }
  }

  function readConvertigoGatewayModelsCache(options) {
    try {
      var file = convertigoGatewayModelsCacheFile(options);
      if (file === null || !file.isFile()) { return null; }
      var cached = JSON.parse(readTextFile(file));
      if (trim(cached.url) !== convertigoGatewayUrl(options)) { return null; }
      var names = normalizeGatewayModelIds(cached.models);
      return names.length ? { models: names, at: Number(cached.at) || 0, efforts: cached.efforts && typeof cached.efforts === "object" ? cached.efforts : {} } : null;
    } catch (_ignoreGatewayCacheRead) {
      return null;
    }
  }

  var convertigoGatewayKeyRejected = false;

  function fetchConvertigoGatewayModelIds(options, apiKey) {
    var connection = null, stream = null;
    try {
      connection = new URL(convertigoGatewayUrl(options) + "/models").openConnection();
      connection.setConnectTimeout(4000);
      connection.setReadTimeout(6000);
      connection.setRequestMethod("GET");
      connection.setRequestProperty("Accept", "application/json");
      connection.setRequestProperty("Authorization", "Bearer " + apiKey);
      var gatewayStatus = connection.getResponseCode();
      convertigoGatewayKeyRejected = gatewayStatus === 401 || gatewayStatus === 403;
      if (convertigoGatewayKeyRejected) {
        try { log.warn("The Convertigo gateway rejected the agent key (HTTP " + gatewayStatus + "). Check " + filePath(convertigoGatewayKeyFile(options))); } catch (_ignoreRejectedKeyLog) {}
      }
      if (gatewayStatus !== 200) { return []; }
      stream = connection.getInputStream();
      var body = String(new java.lang.String(stream.readAllBytes(), "UTF-8"));
      var data = JSON.parse(body).data || [];
      var ids = [];
      for (var i = 0; i < data.length; i++) { ids.push(data[i] && data[i].id); }
      return normalizeGatewayModelIds(ids);
    } catch (_ignoreGatewayModels) {
      try { log.warn("Unable to list the Convertigo gateway models: " + String(_ignoreGatewayModels)); } catch (_ignoreGatewayModelsLog) {}
      return [];
    } finally {
      try { if (stream !== null) stream.close(); } catch (_ignoreGatewayStreamClose) {}
      try { if (connection !== null) connection.disconnect(); } catch (_ignoreGatewayDisconnect) {}
    }
  }

  // Accepted reasoning_effort values differ per model (GLM 5.2 takes medium, GLM 5.3 does not)
  // and the gateway does not publish them, so each new model is probed once with one-token
  // requests. The answer is cached with the offer.
  var GATEWAY_REASONING_EFFORTS = ["low", "medium", "high", "max"];

  function probeGatewayModelEffort(options, apiKey, name, effort) {
    var connection = null, stream = null;
    try {
      connection = new URL(convertigoGatewayUrl(options) + "/chat/completions").openConnection();
      connection.setConnectTimeout(4000);
      connection.setReadTimeout(20000);
      connection.setRequestMethod("POST");
      connection.setDoOutput(true);
      connection.setRequestProperty("Content-Type", "application/json");
      connection.setRequestProperty("Authorization", "Bearer " + apiKey);
      var body = JSON.stringify({ model: name, messages: [{ role: "user", content: "ok" }], max_tokens: 1, stream: false, reasoning_effort: effort });
      var out = connection.getOutputStream();
      out.write(new java.lang.String(body).getBytes("UTF-8"));
      out.close();
      var code = connection.getResponseCode();
      stream = code >= 400 ? connection.getErrorStream() : connection.getInputStream();
      var text = stream === null ? "" : String(new java.lang.String(stream.readAllBytes(), "UTF-8"));
      if (code === 200) { return "yes"; }
      if ((code === 400 || code === 422) && /reasoning_effort|not supported|UnsupportedParams/i.test(text)) { return "no"; }
      return "unknown";
    } catch (_ignoreEffortProbe) {
      return "unknown";
    } finally {
      try { if (stream !== null) stream.close(); } catch (_ignoreProbeStreamClose) {}
      try { if (connection !== null) connection.disconnect(); } catch (_ignoreProbeDisconnect) {}
    }
  }

  function probeGatewayModelEfforts(options, apiKey, name) {
    var supported = [];
    for (var i = 0; i < GATEWAY_REASONING_EFFORTS.length; i++) {
      var answer = probeGatewayModelEffort(options, apiKey, name, GATEWAY_REASONING_EFFORTS[i]);
      if (answer === "unknown") { return null; }
      if (answer === "yes") { supported.push(GATEWAY_REASONING_EFFORTS[i]); }
    }
    return supported;
  }

  function normalizeGatewayEfforts(value) {
    if (typeof value === "string") { value = value.split(/[\s,;]+/); }
    if (!Array.isArray(value)) { return null; }
    var levels = [];
    for (var i = 0; i < GATEWAY_REASONING_EFFORTS.length; i++) {
      if (value.indexOf(GATEWAY_REASONING_EFFORTS[i]) >= 0) { levels.push(GATEWAY_REASONING_EFFORTS[i]); }
    }
    return levels;
  }

  // null: not probed yet; []: the model takes no reasoning_effort at all.
  function convertigoGatewayModelEfforts(options, name) {
    var explicit = options && options.gatewayModelEfforts;
    if (explicit && typeof explicit === "object" && Object.prototype.hasOwnProperty.call(explicit, name)) {
      return normalizeGatewayEfforts(explicit[name]);
    }
    var cached = readConvertigoGatewayModelsCache(options || {});
    return cached !== null && Object.prototype.hasOwnProperty.call(cached.efforts, name) ? normalizeGatewayEfforts(cached.efforts[name]) : null;
  }

  function gatewayEffortsForAlias(options, alias) {
    alias = trim(alias);
    var explicit = options && options.gatewayModelEfforts;
    var names = [];
    if (explicit && typeof explicit === "object") { for (var key in explicit) { names.push(key); } }
    var cached = readConvertigoGatewayModelsCache(options || {});
    if (cached !== null) { names = names.concat(cached.models); }
    for (var i = 0; i < names.length; i++) {
      if (names[i] === alias || gatewayModelAlias(names[i]) === alias) { return convertigoGatewayModelEfforts(options, names[i]); }
    }
    return null;
  }

  function gatewayEffortFor(requested, supported) {
    requested = trim(requested).toLowerCase();
    if (!requested.length || requested === "off" || requested === "none") { return ""; }
    if (supported === null) { return requested === "medium" ? "high" : requested; }
    if (!supported.length) { return ""; }
    if (supported.indexOf(requested) >= 0) { return requested; }
    // Closest accepted level, preferring the stronger one: medium becomes high on GLM 5.3.
    var rank = GATEWAY_REASONING_EFFORTS.indexOf(requested);
    for (var up = rank + 1; rank >= 0 && up < GATEWAY_REASONING_EFFORTS.length; up++) {
      if (supported.indexOf(GATEWAY_REASONING_EFFORTS[up]) >= 0) { return GATEWAY_REASONING_EFFORTS[up]; }
    }
    return supported[supported.length - 1];
  }

  function convertigoGatewayModelNames(options, vibeHome) {
    options = options || {};
    // An explicit model, or an explicit list, pins the offer and skips the gateway.
    var pinned = trim(options.llmGatewayModel || options.gatewayModel);
    if (pinned.length) { return [pinned]; }
    var listed = normalizeGatewayModelIds(options.gatewayModelIds || options.llmGatewayModels);
    if (listed.length) { return listed; }
    var cached = readConvertigoGatewayModelsCache(options);
    if (cached !== null && now() - cached.at < CONVERTIGO_LLM_GATEWAY_MODELS_CACHE_MS) { return cached.models; }
    var apiKey = boolValue(options.dryRun, false) ? "" : convertigoGatewayApiKey(options, vibeHome);
    if (apiKey.length) {
      var fetched = fetchConvertigoGatewayModelIds(options, apiKey);
      if (fetched.length) {
        try {
          var knownEfforts = cached !== null ? cached.efforts : {};
          var efforts = {};
          for (var effortIndex = 0; effortIndex < fetched.length; effortIndex++) {
            var modelName = fetched[effortIndex];
            var levels = Object.prototype.hasOwnProperty.call(knownEfforts, modelName) ? normalizeGatewayEfforts(knownEfforts[modelName]) : null;
            if (levels === null) { levels = probeGatewayModelEfforts(options, apiKey, modelName); }
            if (levels !== null) { efforts[modelName] = levels; }
          }
          var cacheFile = convertigoGatewayModelsCacheFile(options);
          if (cacheFile !== null) {
            ensureDirectory(cacheFile.getParentFile());
            writeTextFile(cacheFile, JSON.stringify({ url: convertigoGatewayUrl(options), at: now(), models: fetched, efforts: efforts }));
          }
        } catch (_ignoreGatewayCacheWrite) {}
        return fetched;
      }
    }
    // Gateway unreachable or no key yet: last known offer, then the built-in model.
    return cached !== null ? cached.models : [CONVERTIGO_LLM_GATEWAY_MODEL];
  }

  function convertigoGatewayDefaultAlias(options, names) {
    var wanted = trim(options && (options.llmGatewayDefaultModel || options.model || options.agentModel));
    if (!wanted.length) {
      try {
        var symbol = Packages.com.twinsoft.convertigo.engine.Engine.theApp.databaseObjectsManager.symbolsGetValue(CONVERTIGO_LLM_GATEWAY_DEFAULT_MODEL_SYMBOL);
        wanted = symbol === null || typeof symbol === "undefined" ? "" : trim(String(symbol));
      } catch (_ignoreGatewayDefaultSymbol) {}
    }
    for (var i = 0; i < names.length; i++) {
      if (wanted.length && (names[i] === wanted || gatewayModelAlias(names[i]) === wanted)) { return gatewayModelAlias(names[i]); }
    }
    return gatewayModelAlias(names[0]);
  }

  function vibeGatewayModelSpecs(options, vibeHome) {
    var names = convertigoGatewayModelNames(options, vibeHome);
    var active = convertigoGatewayDefaultAlias(options, names);
    var thinking = convertigoGatewayThinking(options);
    var specs = [], seenAlias = {};
    for (var i = 0; i < names.length; i++) {
      var alias = gatewayModelAlias(names[i]);
      if (seenAlias[alias]) { continue; }
      seenAlias[alias] = true;
      var modelEfforts = convertigoGatewayModelEfforts(options, names[i]);
      specs.push({
        activeModel: active,
        name: names[i],
        alias: alias,
        provider: "convertigo",
        efforts: modelEfforts,
        thinking: gatewayEffortFor(thinking, modelEfforts),
        temperature: "1.0",
        inputPrice: "1.4",
        outputPrice: "4.4",
        builtIn: false,
        supportsImages: VIBE_GLM_SUPPORTS_IMAGES
      });
    }
    return specs;
  }

  function vibeGatewayModelsFingerprint(specs) {
    // Name and thinking level: a level that a model stopped accepting rewrites the config too.
    var names = [];
    for (var i = 0; i < specs.length; i++) { names.push(specs[i].name + ":" + specs[i].thinking); }
    return names.sort().join(",");
  }

  function vibeGatewayModelSpec(options, vibeHome) {
    var specs = vibeGatewayModelSpecs(options, vibeHome);
    for (var i = 0; i < specs.length; i++) {
      if (specs[i].alias === specs[i].activeModel) { return specs[i]; }
    }
    return specs[0];
  }

  function convertigoGatewayKeyFile(options) {
    // Stable drop location for the per-user gateway key (filled by the future automatic
    // onboarding, or by hand meanwhile). The first line is the key.
    try {
      var workspaceRoot = resolveWorkspaceRoot(options || {});
      return new File(childPath(childPath(workspaceRoot, "agents"), "convertigo"), "llm-api-key");
    } catch (_ignoreGatewayKeyFile) {
      return null;
    }
  }

  function readConvertigoGatewayKeyFile(options) {
    try {
      var file = convertigoGatewayKeyFile(options);
      if (file !== null && file.isFile()) {
        var first = trim(readTextFile(file).split(/\r?\n/)[0]);
        return first.length && first.indexOf("#") !== 0 ? first : "";
      }
    } catch (_ignoreGatewayKeyRead) {}
    return "";
  }

  // The key file is the stable drop location: whenever its content changes, it replaces the key
  // of every Vibe home at the next start. The .env remembers the fingerprint of the file key it
  // was given, because file dates are useless here (the .env is copied between homes). A key
  // stored through vibeGatewayKeyStore stays until the file changes again.
  var CONVERTIGO_LLM_API_KEY_FILE_MARKER = "CONVERTIGO_LLM_API_KEY_FILE_SHA";

  function gatewayKeyFingerprint(key) {
    try {
      var digest = java.security.MessageDigest.getInstance("SHA-256").digest(new java.lang.String(String(key)).getBytes("UTF-8"));
      var hex = "";
      for (var i = 0; i < 8; i++) {
        var value = (digest[i] & 0xff).toString(16);
        hex += value.length < 2 ? "0" + value : value;
      }
      return hex;
    } catch (_ignoreKeyFingerprint) {
      return "";
    }
  }

  function gatewayKeySyncDecision(envKey, envMarker, fileKey, fileFingerprint) {
    envKey = trim(envKey); envMarker = trim(envMarker); fileKey = trim(fileKey); fileFingerprint = trim(fileFingerprint);
    if (!fileKey.length) {
      return { key: envKey, write: false, reason: "no_key_file" };
    }
    if (!envKey.length) {
      return { key: fileKey, write: true, reason: "env_empty" };
    }
    if (fileFingerprint.length && envMarker === fileFingerprint) {
      return { key: envKey, write: false, reason: "file_already_applied" };
    }
    // Unknown or outdated marker: the file changed since this home was written, or the home
    // predates the marker (it may hold a placeholder typed before the real key was dropped).
    return { key: fileKey, write: true, reason: envKey === fileKey ? "marker_missing" : "file_changed" };
  }

  function resolveConvertigoGatewayKey(options, vibeHome) {
    var envKey = "", envMarker = "";
    try {
      if (trim(vibeHome).length) {
        var parsed = readEnvFile(new File(trim(vibeHome), ".env"));
        envKey = trim(parsed.values[CONVERTIGO_LLM_API_KEY_ENV]);
        envMarker = trim(parsed.values[CONVERTIGO_LLM_API_KEY_FILE_MARKER]);
      }
    } catch (_ignoreGatewayEnvRead) {}
    var fileKey = readConvertigoGatewayKeyFile(options);
    var decision = gatewayKeySyncDecision(envKey, envMarker, fileKey, fileKey.length ? gatewayKeyFingerprint(fileKey) : "");
    decision.fileFingerprint = fileKey.length ? gatewayKeyFingerprint(fileKey) : "";
    return decision;
  }

  function syncConvertigoGatewayKey(options, homeDir, report) {
    var decision = resolveConvertigoGatewayKey(options, filePath(homeDir));
    if (decision.write) {
      var envFile = new File(homeDir, ".env");
      writeEnvFileValue(envFile, CONVERTIGO_LLM_API_KEY_ENV, decision.key);
      if (decision.fileFingerprint.length) {
        writeEnvFileValue(envFile, CONVERTIGO_LLM_API_KEY_FILE_MARKER, decision.fileFingerprint);
      }
      if (report && report.copied) { report.copied.push(".env"); }
      if (decision.reason === "file_changed") {
        try { log.info("Convertigo agent key replaced from " + filePath(convertigoGatewayKeyFile(options)) + " in " + filePath(homeDir)); } catch (_ignoreKeySyncLog) {}
      }
    }
    return decision;
  }

  function studioOwnerEmail() {
    // The Studio PSC carries the registered owner email; the class is only present in Studio.
    try {
      var plugin = Packages.com.twinsoft.convertigo.eclipse.ConvertigoPlugin;
      var properties = plugin.decodePsc();
      var email = properties === null ? "" : trim(properties.getProperty("owner.email"));
      return email.length ? email : "";
    } catch (_ignoreStudioOwnerEmail) {
      return "";
    }
  }

  function parseVibeGatewayUrl(text) {
    var pattern = /\[\[providers\]\]([\s\S]*?)(?=\n\[\[|\n\[|$)/g;
    var match;
    while ((match = pattern.exec(String(text || ""))) !== null) {
      var block = match[1];
      if (!/\nname\s*=\s*["']convertigo["']/.test("\n" + block)) {
        continue;
      }
      var base = block.match(/\napi_base\s*=\s*["']([^"']+)["']/);
      return base ? trim(base[1]).replace(/\/+$/, "") : "";
    }
    return "";
  }

  function parseVibeGatewayModels(text) {
    var pattern = /\[\[models\]\]([\s\S]*?)(?=\n\[\[|\n\[|$)/g;
    var match, names = [];
    while ((match = pattern.exec(String(text || ""))) !== null) {
      var block = "\n" + match[1];
      if (!/\nprovider\s*=\s*["']convertigo["']/.test(block)) { continue; }
      var name = block.match(/\nname\s*=\s*["']([^"']+)["']/);
      var thinking = block.match(/\nthinking\s*=\s*["']([^"']*)["']/);
      if (name) { names.push(trim(name[1]) + ":" + (thinking ? trim(thinking[1]) : "")); }
    }
    return names.sort().join(",");
  }

  var VIBE_IMAGE_MIME_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
  var VIBE_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
  var VIBE_MAX_IMAGES_PER_MESSAGE = 8;
  var STUDIO_ROUTER_SKILL_SLUG = "convertigo-studio";
  var MANAGED_SKILL_BUNDLE_STATE_FILE = "managed-skill-bundle.json";
  var FLOW_MINIMUM_CONVERTIGO_VERSION = "8.5.0";
  var FLOW_REQUIRED_PROJECTS = ["lib_flow_engine", "lib_flow_mcp"];
  var flowCapabilityAvailabilityCache = null;
  var AGENT_CAPABILITY_PROFILES = {
    generalist: {
      id: "generalist",
      label: "Convertigo Generalist",
      authoringPolicy: "legacy-only",
      aliases: ["generalist", "legacy"],
      capabilityIds: ["convertigo-legacy"],
      supportedProviders: ["codex", "vibe", "claude"],
      mcpPath: FALLBACK_MCP_PATH,
      mcpServerName: "convertigo",
      setupProject: "lib_ConvertigoMCP",
      setupSkillKey: "generalist",
      skillSlug: "convertigo-generalist",
      specialistSkillSlugs: [],
      setupRequired: false
    },
    nocode: {
      id: "nocode",
      label: "Convertigo NoCode",
      authoringPolicy: "nocode",
      aliases: ["nocode", "no-code", "c8oforms", "forms"],
      capabilityIds: ["convertigo-nocode"],
      supportedProviders: ["codex", "vibe", "claude"],
      mcpPath: FALLBACK_MCP_PATH,
      mcpServerName: "convertigo",
      setupProject: "lib_ConvertigoMCP",
      setupSkillKey: "nocode",
      skillSlug: "convertigo-nocode",
      specialistSkillSlugs: [],
      setupRequired: false
    },
    flow: {
      id: "flow",
      label: "Convertigo Flow",
      authoringPolicy: "flow-only",
      aliases: ["flow", "flowscript", "flow-svelte", "frontbuilder-svelte"],
      capabilityIds: ["convertigo-flow", "flow-backend", "flow-frontend-svelte"],
      supportedProviders: ["codex"],
      mcpPath: FALLBACK_FLOW_MCP_PATH,
      mcpServerName: "convertigo-flow",
      setupProject: "lib_flow_mcp",
      setupSkillKey: "",
      skillSlug: "convertigo-flow-mcp",
      specialistSkillSlugs: ["convertigo-flow-backend", "convertigo-flow-frontend-svelte"],
      setupRequired: true
    }
  };

  var File = Packages.java.io.File;
  var FileOutputStream = Packages.java.io.FileOutputStream;
  var RandomAccessFile = Packages.java.io.RandomAccessFile;
  var BufferedReader = Packages.java.io.BufferedReader;
  var InputStreamReader = Packages.java.io.InputStreamReader;
  var OutputStreamWriter = Packages.java.io.OutputStreamWriter;
  var BufferedWriter = Packages.java.io.BufferedWriter;
  var ProcessBuilder = Packages.java.lang.ProcessBuilder;
  var ProcessHandle = Packages.java.lang.ProcessHandle;
  var Runnable = Packages.java.lang.Runnable;
  var Thread = Packages.java.lang.Thread;
  var System = Packages.java.lang.System;
  var UUID = Packages.java.util.UUID;
  var ArrayList = Packages.java.util.ArrayList;
  var HashMap = Packages.java.util.HashMap;
  var ConcurrentHashMap = Packages.java.util.concurrent.ConcurrentHashMap;
  var LinkedHashMap = Packages.java.util.LinkedHashMap;
  var Base64 = Packages.java.util.Base64;
  var Collections = Packages.java.util.Collections;
  var TimeUnit = Packages.java.util.concurrent.TimeUnit;
  var Files = Packages.java.nio.file.Files;
  var StandardCharsets = Packages.java.nio.charset.StandardCharsets;
  var StandardCopyOption = Packages.java.nio.file.StandardCopyOption;
  var StandardOpenOption = Packages.java.nio.file.StandardOpenOption;
  var MessageDigest = Packages.java.security.MessageDigest;
  var URL = Packages.java.net.URL;
  var InternalRequester = Packages.com.twinsoft.convertigo.engine.requesters.InternalRequester;
  var XMLUtils = Packages.com.twinsoft.convertigo.engine.util.XMLUtils;
  var JsonOutput = Packages.com.twinsoft.convertigo.engine.enums.JsonOutput;
  var Engine = Packages.com.twinsoft.convertigo.engine.Engine;
  var ProcessUtils = Packages.com.twinsoft.convertigo.engine.util.ProcessUtils;
  var NetworkUtils = Packages.com.twinsoft.convertigo.engine.util.NetworkUtils;

  var DEFAULT_PYTHON_VERSION = "3.12.13";
  var DEFAULT_PYTHON_BUILD_TAG = "20260610";
  var DEFAULT_PYTHON_ARCHIVE_FLAVOR = "install_only_stripped";
  var DEFAULT_PYTHON_ASSET_PREFIX = "https://github.com/astral-sh/python-build-standalone/releases/download/{tag}";

  function now() {
    return System.currentTimeMillis();
  }

  function trim(value) {
    if (value === null || typeof value === "undefined") {
      return "";
    }
    return String(value).replace(/^\s+|\s+$/g, "");
  }

  function firstNonBlank(values) {
    for (var i = 0; values && i < values.length; i++) {
      var value = trim(values[i]);
      if (value.length) {
        return value;
      }
    }
    return "";
  }

  function requestParameter(name) {
    try {
      var request = context && context.httpServletRequest ? context.httpServletRequest : null;
      if (request !== null) {
        return trim(request.getParameter(String(name)));
      }
    } catch (_ignoreRequestParameter) {}
    return "";
  }

  function optionOrRequest(options, name) {
    options = options || {};
    var value = trim(options[name]);
    if (value.length) {
      return value;
    }
    return requestParameter(name);
  }

  function optionsWithRequestFallbacks(options) {
    options = options || {};
    var copy = {};
    for (var key in options) {
      if (Object.prototype.hasOwnProperty.call(options, key)) {
        copy[key] = options[key];
      }
    }
    [
      "provider", "agent", "agentProvider", "targetProject", "projectName", "projectId", "primaryProject",
      "conversationId", "threadid", "handle",
      "userId", "agentProfile", "skillProfile", "assistantContext", "assistantSurface", "profile",
      "currentUrl", "currentRoute", "currentPath", "currentFormId", "currentFormUrl",
      "nocodeCurrentUrl", "nocodeCurrentRoute", "nocodeCurrentFormId", "nocodeCurrentFormUrl",
      "formId", "pageId", "applicationId", "currentPage", "currentApplicationId",
      "codexHomeScope", "vibeHomeScope", "claudeHomeScope", "homeScope", "codexHome", "vibeHome", "claudeHome", "agentHome",
      "vibeProfile", "gatewayProfile", "agentMode", "llmGatewayUrl", "llmGatewayModel", "llmGatewayThinking", "gatewayApiKey",
      "claudePath",
      "mcpEndpoint", "workspaceRoot", "settingsTimeoutMs", "modelsTimeoutMs",
      "model", "reasoningEffort", "reasoningLevel", "serviceTier", "savePreferences",
      "checkUpdates", "refreshUpdateCheck", "updateCheckTimeoutMs", "updateCheckCacheMs", "runtimePresenceOnly",
      "codexRuntimeMode", "codexProtocol",
      "agentRevealMode", "convertigoRevealMode", "uiRevealMode", "revealMode",
      "nocodeMcpToken", "noCodeMcpToken", "mcpBearerToken",
      "nocodeMcpTokenHandle", "noCodeMcpTokenHandle", "mcpBearerTokenHandle",
      "browserDebugUrl", "browserDevToolsJsonUrl", "browserDevToolsWebSocketUrl",
      "playwrightCdpEndpoint", "playwrightMcpEndpoint", "viewerCdpEndpoint", "viewerDebugPort"
    ].forEach(function (name) {
      if (!trim(copy[name]).length) {
        var value = requestParameter(name);
        if (value.length) {
          copy[name] = value;
        }
      }
    });
    return copy;
  }

  function boolValue(value, defaultValue) {
    if (value === null || typeof value === "undefined" || trim(value) === "") {
      return defaultValue === true;
    }
    if (value === true || value === false) {
      return value === true;
    }
    var text = trim(value).toLowerCase();
    return text === "true" || text === "1" || text === "yes" || text === "on";
  }

  function revealModeEnabled(options, entry) {
    options = options || {};
    var values = [
      options.agentRevealMode,
      options.convertigoRevealMode,
      options.uiRevealMode,
      options.revealMode,
      options.reveal
    ];
    for (var i = 0; i < values.length; i++) {
      if (values[i] !== null && typeof values[i] !== "undefined" && trim(values[i]).length) {
        return boolValue(values[i], false);
      }
    }
    if (entry && entry.convertigoRevealMode === true) {
      return true;
    }
    return false;
  }

  function firstDefinedOption(options, names) {
    options = options || {};
    for (var i = 0; i < names.length; i++) {
      var value = options[names[i]];
      if (value !== null && typeof value !== "undefined" && trim(value).length) {
        return value;
      }
    }
    return "";
  }

  // MCP request logging: the Convertigo engine mutes context logs for requests carrying
  // X-Convertigo-No-Log. Controlled by the mcpNoLog option, then by the global symbol
  // agentbridge.mcp.nolog (default true): agent tool traffic is verbose and rarely useful.
  var MCP_NOLOG_SYMBOL = "agentbridge.mcp.nolog";

  function mcpNoLogEnabled(options) {
    options = options || {};
    var explicit = firstDefinedOption(options, ["mcpNoLog", "mcpNolog", "noLog"]);
    if (trim(explicit).length) {
      return boolValue(explicit, true);
    }
    try {
      var symbol = Packages.com.twinsoft.convertigo.engine.Engine.theApp.databaseObjectsManager.symbolsGetValue(MCP_NOLOG_SYMBOL);
      if (symbol !== null && typeof symbol !== "undefined" && trim(symbol).length) {
        return boolValue(String(symbol), true);
      }
    } catch (_ignoreNoLogSymbol) {}
    return true;
  }

  function withRevealModePrompt(promptText, enabled) {
    var text = String(promptText || "");
    if (enabled !== true) {
      return text;
    }
    var marker = "Convertigo runtime reveal mode is enabled";
    if (text.indexOf(marker) !== -1) {
      return text;
    }
    var lines = [
      marker + ".",
      "When calling supported Convertigo MCP mutation/viewer tools that should visibly move Studio or No Code Studio, pass `reveal:true`: `databaseobject-tree-apply`, `mobile-builder-open`, `nocode-form-create`, `nocode-form-edit`, and `nocode-form-update`."
    ];
    if (flowCapabilityAvailable()) {
      lines.push("For Flow frontend source authoring, pass `reveal:true` to `code-set` or `code-patch`; Studio will refresh the virtual tree and expand the affected source even when the project was collapsed.");
      lines.push("After the first Flow frontend `code-get` of the turn, call `frontend-svelte-action` with `actionId:\"dev.ensure\", wait:false` before mutating; this recovers Vite after a Studio restart without restarting an active viewer.");
      lines.push("Before using Playwright with a Flow frontend, call `frontend-svelte-action` with `actionId:\"dev.open\"` and continue only when it reports `browserControlReady:true`.");
    }
    return lines.concat([
      "When grouping mutations with `batch-call`, pass top-level `reveal:true`; the batch will reveal the final touched object after its deferred refresh.",
      "For `mobile-builder-open`, use `wait:false` for reveal/focus polls; reserve long `wait:true` calls for readiness proof and omit `reveal` unless the user specifically needs UI focus.",
      "Do not pass `reveal:true` on read-only calls. Treat skipped, unsupported, or intent reveal results as UI hints, not mutation failures.",
      "",
      text
    ]).join("\n");
  }

  function withManagedGuidancePreflight(promptText, options) {
    var text = String(promptText || "");
    var marker = "Convertigo managed preflight for this turn";
    if (text.indexOf(marker) !== -1) {
      return text;
    }
    options = options || {};
    var endpoint = trim(options.mcpEndpoint);
    var bundle = options.skillBundle || null;
    var lines = [
      marker + ":",
      "- Scoped agent setup status: current.",
      "- Current Convertigo guidance version: " + MCP_GUIDANCE_VERSION + ".",
      "- Do not call `_setupCodex`, do not update the global Codex home, and do not repeat setup for this turn.",
      "- Treat guidance mismatch warnings from earlier conversation turns as stale. React only if a current Convertigo MCP call returns a new mismatch warning."
    ];
    if (endpoint.length) {
      lines.splice(2, 0, "- Current Convertigo MCP endpoint: " + endpoint + ".");
    }
    if (bundle && trim(bundle.fingerprint).length) {
      lines.splice(3, 0, "- Current managed skill bundle fingerprint: " + bundle.fingerprint + ".");
      if (bundle.refreshRequired === true && bundle.pendingSlugs && bundle.pendingSlugs.length) {
        lines.splice(4, 0,
          "- The managed skill bundle changed for this conversation. Before any authoring mutation, fully reread these updated skills: " + bundle.pendingSlugs.join(", ") + ".",
          "- This bundle-refresh requirement overrides later warm-resume guidance that says not to reread managed skills. Do not acknowledge the bundle from memory; the bridge records the actual reads."
        );
      } else {
        lines.splice(4, 0, "- This conversation already acknowledged the current managed skill bundle; do not reread unchanged skills.");
      }
    }
    lines.push("");
    lines.push(text);
    return lines.join("\n");
  }

  function mcpTransportEndpoint(endpoint, jsonOnly) {
    var text = trim(endpoint);
    var fragment = "";
    var hash = text.indexOf("#");
    if (hash >= 0) {
      fragment = text.substring(hash);
      text = text.substring(0, hash);
    }
    if (/(^|[?&])jsonOnly=[^&]*/i.test(text)) {
      text = text.replace(/(^|[?&])jsonOnly=[^&]*/i, "$1jsonOnly=" + (jsonOnly ? "true" : "false"));
    } else {
      text += (text.indexOf("?") >= 0 ? "&" : "?") + "jsonOnly=" + (jsonOnly ? "true" : "false");
    }
    return text + fragment;
  }

  function managedMcpTransportEndpoint(endpoint) {
    return mcpTransportEndpoint(endpoint, true);
  }

  function endpointQueryParameter(endpoint, name, value) {
    var text = trim(endpoint);
    var fragment = "";
    var hash = text.indexOf("#");
    if (hash >= 0) {
      fragment = text.substring(hash);
      text = text.substring(0, hash);
    }
    var encodedName = String(name || "");
    var encodedValue = encodeURIComponent(String(value || ""));
    var pattern = new RegExp("(^|[?&])" + encodedName + "=[^&]*", "i");
    if (pattern.test(text)) {
      text = text.replace(pattern, "$1" + encodedName + "=" + encodedValue);
    } else {
      text += (text.indexOf("?") >= 0 ? "&" : "?") + encodedName + "=" + encodedValue;
    }
    return text + fragment;
  }

  // Identity of the deployed MCP tool catalog. Vibe keys its persistent tool
  // cache on sha256 of the serialized server entry and keeps it for 24 h, so the
  // URL is the only lever the bridge has to invalidate that cache when the MCP
  // stack changes under an existing home. The project version alone would miss a
  // catalog change shipped without a version bump, and the skill hash alone would
  // miss a new tool shipped without a skill change, so both are folded in.
  function managedMcpCatalogRevision(options) {
    var parts = [];
    var project = null;
    try {
      var manager = Packages.com.twinsoft.convertigo.engine.Engine.theApp.databaseObjectsManager;
      project = manager.getOriginalProjectByName(MCP_CATALOG_PROJECT);
      if (project === null || typeof project === "undefined") {
        project = manager.getProjectByName(MCP_CATALOG_PROJECT);
      }
    } catch (_ignoreCatalogProject) {
      project = null;
    }
    if (project !== null && typeof project !== "undefined" && project.getVersion) {
      try {
        var version = trim(project.getVersion());
        if (version.length) {
          parts.push(version);
        }
      } catch (_ignoreCatalogVersion) {}
    }
    try {
      // The source skill, not the copy installed in the home: skills are
      // synchronized after the config is written, so the home copy would always
      // be one session behind.
      var skillSource = noCodeSkillSourceFile(options);
      if (skillSource !== null && skillSource.isFile()) {
        parts.push(sha256File(skillSource));
      }
    } catch (_ignoreCatalogSkill) {}
    return parts.length ? hashShort(parts.join(":")) : "";
  }

  function vibeMcpTransportEndpoint(endpoint, options) {
    // Vibe's MCP client requires standard text content alongside structuredContent.
    var url = endpointQueryParameter(
      mcpTransportEndpoint(endpoint, false),
      "descriptorVersion",
      MCP_GUIDANCE_VERSION
    );
    // Deliberately a separate parameter: the MCP compares descriptorVersion
    // byte for byte against its own guidance version and would report
    // mcp_guidance_version_mismatch on every guarded tool call. toolsRevision is
    // ignored server side; it exists only to change the cache key.
    var revision = managedMcpCatalogRevision(options);
    return revision.length ? endpointQueryParameter(url, "toolsRevision", revision) : url;
  }

  function intValue(value, defaultValue, minValue, maxValue) {
    var parsed = parseInt(trim(value), 10);
    if (isNaN(parsed)) {
      parsed = defaultValue;
    }
    if (typeof minValue === "number" && parsed < minValue) {
      parsed = minValue;
    }
    if (typeof maxValue === "number" && parsed > maxValue) {
      parsed = maxValue;
    }
    return parsed;
  }

  function parseObject(value, defaultValue) {
    if (value === null || typeof value === "undefined" || trim(value) === "") {
      return defaultValue || {};
    }
    var className = "";
    try {
      if (value && value.getClass) {
        className = String(value.getClass().getName());
      }
    } catch (_ignoreClassName) {}
    var text = trim(value);
    if (className.indexOf("String") >= 0 || text.indexOf("{") === 0 || text.indexOf("[") === 0) {
      return JSON.parse(String(value));
    }
    if (typeof value === "object") {
      return value;
    }
    return JSON.parse(String(value));
  }

  function parseCommand(value, fallback) {
    if (value === null || typeof value === "undefined" || trim(value) === "") {
      return fallback;
    }
    if (typeof value === "object" && value.length) {
      var fromArray = [];
      for (var i = 0; i < value.length; i++) {
        fromArray.push(String(value[i]));
      }
      return fromArray;
    }
    var text = trim(value);
    if (text.indexOf("[") === 0) {
      var parsed = JSON.parse(text);
      var arr = [];
      for (var j = 0; j < parsed.length; j++) {
        arr.push(String(parsed[j]));
      }
      return arr;
    }
    return [text];
  }

  function toJavaList(values) {
    var list = new ArrayList();
    for (var i = 0; i < values.length; i++) {
      list.add(String(values[i]));
    }
    return list;
  }

  function envObjectToMap(pbEnv, env) {
    if (!env) {
      return;
    }
    for (var key in env) {
      if (Object.prototype.hasOwnProperty.call(env, key) && env[key] !== null && typeof env[key] !== "undefined") {
        pbEnv.put(String(key), String(env[key]));
      }
    }
  }

  function proxyEnvironmentFromSettings(settings) {
    settings = settings || {};
    if (settings.enabled !== true || settings.direct === true || !trim(settings.host).length || Number(settings.port || 0) <= 0) {
      return {};
    }
    var method = trim(settings.method).toLowerCase();
    var proxyUrl = trim(settings.localProxyUrl);
    if (!proxyUrl.length) {
      var credentials = "";
      if (method === "basic" && trim(settings.user).length) {
        credentials = encodeURIComponent(String(settings.user)) + ":" + encodeURIComponent(String(settings.password || "")) + "@";
      }
      proxyUrl = "http://" + credentials + trim(settings.host) + ":" + Number(settings.port);
    }
    var noProxy = trim(settings.noProxy);
    return {
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      NO_PROXY: noProxy,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      no_proxy: noProxy,
      npm_config_proxy: proxyUrl,
      npm_config_https_proxy: proxyUrl,
      PIP_PROXY: proxyUrl
    };
  }

  function engineProxySettings(targetUrl) {
    var settings = {
      enabled: false,
      direct: false,
      mode: "off",
      method: "anonymous",
      host: "",
      port: 0,
      user: "",
      password: "",
      noProxy: "",
      localProxyUrl: ""
    };
    try {
      var manager = Engine.theApp && Engine.theApp.proxyManager;
      if (!manager || !manager.isEnabled()) {
        return settings;
      }
      settings.mode = trim(manager.proxyMode).toLowerCase();
      settings.method = trim(manager.proxyMethod).toLowerCase();
      settings.user = String(manager.getProxyUser() || "");
      settings.password = String(manager.getProxyPassword() || "");
      var bypass = manager.getBypassDomains();
      var bypassValues = [];
      for (var i = 0; bypass !== null && i < bypass.length; i++) {
        var domain = trim(bypass[i]);
        if (domain.length) {
          bypassValues.push(domain);
        }
      }
      settings.noProxy = bypassValues.join(",");
      if (settings.mode === "manual") {
        settings.host = String(manager.getProxyServer() || "");
        settings.port = Number(manager.getProxyPort() || 0);
      } else if (settings.mode === "auto") {
        var target = trim(targetUrl);
        if (!target.length) {
          return settings;
        }
        var uri = new Packages.java.net.URI(target);
        var pac = manager.getPacInfos(target, String(uri.getHost()));
        if (pac === null) {
          settings.direct = true;
          return settings;
        }
        settings.host = String(pac.getServer() || "");
        settings.port = Number(pac.getPort() || 0);
      }
      settings.enabled = settings.host.length > 0 && settings.port > 0;
      if (settings.enabled && settings.method === "ntlm" && settings.mode === "manual") {
        settings.localProxyUrl = String(Packages.com.twinsoft.convertigo.engine.proxy.ntlm.NtlmConnectProxyBridge.getLocalProxyUrl());
      }
    } catch (_ignoreEngineProxySettings) {}
    return settings;
  }

  function applyEngineProxyEnvironment(pbEnv, targetUrl) {
    var settings = engineProxySettings(targetUrl);
    envObjectToMap(pbEnv, proxyEnvironmentFromSettings(settings));
    return settings;
  }

  function configureHttpRequestProxy(request, configBuilder, targetUrl) {
    var settings = engineProxySettings(targetUrl);
    var proxyEnv = proxyEnvironmentFromSettings(settings);
    var proxyUrl = trim(proxyEnv.HTTPS_PROXY);
    if (!proxyUrl.length) {
      return settings;
    }
    if (settings.method === "ntlm" && !trim(settings.localProxyUrl).length) {
      throw new Error("The PAC-selected NTLM proxy cannot be exposed to this HTTP request");
    }
    var proxyUri = new Packages.java.net.URI(proxyUrl);
    configBuilder.setProxy(new Packages.org.apache.http.HttpHost(String(proxyUri.getHost()), Number(proxyUri.getPort())));
    if (settings.method === "basic" && trim(settings.user).length) {
      var credentials = String(settings.user) + ":" + String(settings.password || "");
      var encoded = Packages.java.util.Base64.getEncoder().encodeToString(new Packages.java.lang.String(credentials).getBytes(StandardCharsets.UTF_8));
      request.setHeader("Proxy-Authorization", "Basic " + String(encoded));
    }
    return settings;
  }

  function agentProxyTargetUrl(provider, env) {
    env = env || {};
    var normalized = normalizeProvider(provider);
    if (normalized === "codex") {
      return trim(env.OPENAI_BASE_URL || env.CODEX_API_BASE_URL) || "https://api.openai.com";
    }
    if (normalized === "vibe") {
      return trim(env.MISTRAL_BASE_URL || env.MISTRAL_API_URL) || "https://api.mistral.ai";
    }
    if (normalized === "claude") {
      return trim(env.ANTHROPIC_BASE_URL) || "https://api.anthropic.com";
    }
    return "";
  }

  function filePath(file) {
    return String(file.getCanonicalPath());
  }

  function childPath(parent, name) {
    return filePath(new File(parent, name));
  }

  function parentPath(path) {
    var parent = new File(String(path)).getParentFile();
    return parent === null ? "" : filePath(parent);
  }

  function pathListAppend(paths, path) {
    var value = trim(path);
    if (!value.length) {
      return;
    }
    for (var i = 0; i < paths.length; i++) {
      if (paths[i] === value) {
        return;
      }
    }
    paths.push(value);
  }

  function commandPathStartsWith(command, directory) {
    var path = trim(command && command.path);
    var root = trim(directory);
    if (!path.length || !root.length) {
      return false;
    }
    try {
      path = filePath(new File(path));
      root = filePath(new File(root));
    } catch (_ignoreCommandPathStartsWith) {}
    return path === root || path.indexOf(root + File.separator) === 0 || path.indexOf(root + "/") === 0;
  }

  function nodeRuntimeSearchPath(options) {
    options = options || {};
    var paths = [];
    var addNodeDir = function (dir) {
      var value = trim(dir);
      if (!value.length) {
        return;
      }
      pathListAppend(paths, value);
      try {
        pathListAppend(paths, childPath(value, "bin"));
      } catch (_ignoreNodeBinPath) {}
    };
    addNodeDir(options.nodeDir || options.nodeInstallDir);
    try {
      addNodeDir(filePath(ProcessUtils.getDefaultNodeDir()));
    } catch (_ignoreDefaultNodeDir) {}
    pathListAppend(paths, "/opt/homebrew/bin");
    pathListAppend(paths, "/usr/local/bin");
    return paths.join(String(File.pathSeparator));
  }

  function normalizeConvertigoBaseUrl(value) {
    var text = trim(value).replace(/\/+$/g, "");
    if (!text.length) {
      return "";
    }
    var marker = text.toLowerCase().indexOf("/convertigo");
    if (marker >= 0) {
      return text.substring(0, marker + "/convertigo".length);
    }
    return text + "/convertigo";
  }

  function engineConvertigoBaseUrl() {
    try {
      var EnginePropertiesManager = Packages.com.twinsoft.convertigo.engine.EnginePropertiesManager;
      var PropertyName = Packages.com.twinsoft.convertigo.engine.EnginePropertiesManager.PropertyName;
      var localUrl = normalizeConvertigoBaseUrl(EnginePropertiesManager.getProperty(PropertyName.APPLICATION_SERVER_CONVERTIGO_URL));
      if (localUrl.length) {
        return localUrl;
      }
      var endpoint = normalizeConvertigoBaseUrl(EnginePropertiesManager.getProperty(PropertyName.APPLICATION_SERVER_CONVERTIGO_ENDPOINT));
      if (endpoint.length) {
        return endpoint;
      }
    } catch (_ignoreEngineConvertigoUrl) {}
    try {
      if (context && context.httpServletRequest) {
        var request = context.httpServletRequest;
        var port = request.getServerPort();
        var portPart = (port === 80 || port === 443) ? "" : ":" + port;
        var requestUrl = normalizeConvertigoBaseUrl(request.getScheme() + "://" + request.getServerName() + portPart + request.getContextPath());
        if (requestUrl.length) {
          return requestUrl;
        }
      }
    } catch (_ignoreRequestConvertigoUrl) {}
    try {
      return "http://localhost:" + (Packages.com.twinsoft.convertigo.engine.Engine.isStudioMode() ? "18080" : "28080") + "/convertigo";
    } catch (_ignoreStudioMode) {
      return "http://localhost:18080/convertigo";
    }
  }

  function defaultMcpEndpoint(profile) {
    var capabilityProfile = agentCapabilityProfile({ agentProfile: profile });
    return engineConvertigoBaseUrl().replace(/\/+$/g, "") + capabilityProfile.mcpPath;
  }

  function resolveMcpEndpoint(options) {
    return trim(options && options.mcpEndpoint) || defaultMcpEndpoint(normalizeSkillProfile(options || {}));
  }

  function copyOptionsWithProfile(options, profile) {
    var copy = {};
    options = options || {};
    for (var key in options) {
      if (Object.prototype.hasOwnProperty.call(options, key)) {
        copy[key] = options[key];
      }
    }
    copy.agentProfile = profile;
    copy.skillProfile = profile;
    copy.profile = profile;
    copy.mcpEndpoint = mcpEndpointForProfile(options, profile);
    return copy;
  }

  function mcpEndpointForProfile(options, profile) {
    var explicit = trim(options && options.mcpEndpoint);
    var capabilityProfile = agentCapabilityProfile({ agentProfile: profile, userId: "studio" });
    if (explicit.length) {
      var replaced = explicit.replace(/\/api\/(?:flow-)?mcp(?:\/?(?:[?#].*)?)$/i, capabilityProfile.mcpPath);
      if (replaced !== explicit) {
        return replaced;
      }
    }
    return defaultMcpEndpoint(profile);
  }

  function isWindows() {
    return String(System.getProperty("os.name") || "").toLowerCase().indexOf("win") >= 0;
  }

  function venvBinPath(venvDir, command) {
    var name = String(command || "python");
    if (isWindows()) {
      if (name.indexOf(".") < 0) {
        name += ".exe";
      }
      return String(new File(new File(venvDir, "Scripts"), name).getAbsolutePath());
    }
    // Canonicalizing bin/python follows its symlink outside the venv and makes pip target the system Python.
    return String(new File(new File(venvDir, "bin"), name).getAbsolutePath());
  }

  function ensureDirectory(file) {
    Files.createDirectories(file.toPath());
  }

  function normalizeWorkspaceRootPath(value) {
    var text = trim(value);
    if (!text.length) {
      return "";
    }
    var root = new File(text);
    var studioWorkspace = new File(root, ".metadata/.plugins/com.twinsoft.convertigo.studio");
    if (studioWorkspace.isDirectory()) {
      return filePath(studioWorkspace);
    }
    return filePath(root);
  }

  function engineWorkspaceRoot() {
    try {
      var workspace = normalizeWorkspaceRootPath(Packages.com.twinsoft.convertigo.engine.Engine.USER_WORKSPACE_PATH);
      if (workspace.length) {
        return workspace;
      }
    } catch (_ignoreEngineWorkspace) {}
    try {
      var propertyWorkspace = normalizeWorkspaceRootPath(System.getProperty("convertigo.cems.user_workspace_path"));
      if (propertyWorkspace.length) {
        return propertyWorkspace;
      }
    } catch (_ignoreEngineWorkspaceProperty) {}
    return "";
  }

  function workspaceRootFromProjectDir(projectDir) {
    if (projectDir === null || typeof projectDir === "undefined") {
      return "";
    }
    var dir = projectDir && projectDir.getParentFile ? projectDir : new File(String(projectDir));
    var parent = dir.getParentFile();
    if (parent === null) {
      return "";
    }
    var studioWorkspace = new File(parent, ".metadata/.plugins/com.twinsoft.convertigo.studio");
    if (studioWorkspace.isDirectory()) {
      return filePath(studioWorkspace);
    }
    if (String(parent.getName()) === "projects" && parent.getParentFile() !== null) {
      return filePath(parent.getParentFile());
    }
    return "";
  }

  function readTextFile(file) {
    if (!file.exists()) {
      return "";
    }
    return String(new java.lang.String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
  }

  function writeTextFile(file, text) {
    var parent = file.getParentFile();
    if (parent !== null) {
      ensureDirectory(parent);
    }
    var bytes = new java.lang.String(String(text)).getBytes(StandardCharsets.UTF_8);
    Files.write(
      file.toPath(),
      bytes,
      StandardOpenOption.CREATE,
      StandardOpenOption.TRUNCATE_EXISTING,
      StandardOpenOption.WRITE
    );
    return bytes.length;
  }

  function readJsonFile(file) {
    try {
      var text = readTextFile(file);
      return trim(text).length ? JSON.parse(text) : null;
    } catch (_ignoreReadJsonFile) {
      return null;
    }
  }

  function writeJsonFile(file, value) {
    writeTextFile(file, JSON.stringify(value || {}, null, 2));
  }

  function managedSkillBundleSlugs(options, provider) {
    if (normalizeSkillProfile(options || {}) === "nocode") {
      return ["convertigo-nocode"];
    }
    var slugs = [
      STUDIO_ROUTER_SKILL_SLUG,
      "convertigo-generalist"
    ];
    if (normalizeProvider(provider || (options && options.provider)) !== "claude" && flowCapabilityAvailable()) {
      slugs.push("convertigo-flow-mcp");
      slugs.push("convertigo-flow-backend");
      slugs.push("convertigo-flow-frontend-svelte");
    }
    return slugs;
  }

  function managedSkillBundleFingerprint(skillHashes) {
    var slugs = Object.keys(skillHashes || {}).sort();
    var values = [];
    for (var i = 0; i < slugs.length; i++) {
      values.push(slugs[i] + ":" + String(skillHashes[slugs[i]] || ""));
    }
    return values.length ? hashShort(values.join("\n")) : "";
  }

  function managedSkillBundleState(options, homePath, provider) {
    var home = trim(homePath);
    var slugs = managedSkillBundleSlugs(options, provider);
    var skillHashes = {};
    var missing = [];
    if (home.length) {
      for (var i = 0; i < slugs.length; i++) {
        var slug = slugs[i];
        var skillFile = new File(new File(new File(home, "skills"), slug), "SKILL.md");
        if (!skillFile.isFile()) {
          missing.push(slug);
          continue;
        }
        skillHashes[slug] = sha256File(skillFile);
      }
    } else {
      missing = slugs.slice(0);
    }
    var fingerprint = managedSkillBundleFingerprint(skillHashes);
    var stateFile = home.length ? new File(home, MANAGED_SKILL_BUNDLE_STATE_FILE) : null;
    var acknowledged = stateFile !== null ? (readJsonFile(stateFile) || {}) : {};
    var acknowledgedHashes = acknowledged.skills && typeof acknowledged.skills === "object"
      ? acknowledged.skills
      : {};
    var pendingSlugs = [];
    for (var j = 0; j < slugs.length; j++) {
      var pendingSlug = slugs[j];
      if (!Object.prototype.hasOwnProperty.call(skillHashes, pendingSlug) ||
          String(acknowledgedHashes[pendingSlug] || "") !== String(skillHashes[pendingSlug] || "")) {
        pendingSlugs.push(pendingSlug);
      }
    }
    return {
      ready: home.length > 0 && missing.length === 0,
      fingerprint: fingerprint,
      acknowledgedFingerprint: trim(acknowledged.fingerprint),
      refreshRequired: missing.length > 0 || pendingSlugs.length > 0,
      slugs: slugs,
      pendingSlugs: pendingSlugs,
      missingSlugs: missing,
      skills: skillHashes,
      stateFile: stateFile === null ? "" : filePath(stateFile),
      acknowledgedAt: Number(acknowledged.acknowledgedAt || 0)
    };
  }

  function acknowledgeManagedSkillBundle(homePath, bundle) {
    var home = trim(homePath);
    if (!home.length || !bundle || bundle.ready !== true || !trim(bundle.fingerprint).length) {
      return false;
    }
    writeJsonFile(new File(home, MANAGED_SKILL_BUNDLE_STATE_FILE), {
      version: 1,
      fingerprint: bundle.fingerprint,
      skills: bundle.skills,
      acknowledgedAt: now()
    });
    return true;
  }

  function copyFileBinary(source, target) {
    var parent = target.getParentFile();
    if (parent !== null) {
      ensureDirectory(parent);
    }
    Files.copy(source.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING);
  }

  function copyDirectoryTree(source, target) {
    if (source.isDirectory()) {
      ensureDirectory(target);
      var children = source.listFiles();
      if (children === null) {
        return;
      }
      for (var i = 0; i < children.length; i++) {
        copyDirectoryTree(children[i], new File(target, children[i].getName()));
      }
      return;
    }
    if (source.isFile()) {
      copyFileBinary(source, target);
    }
  }

  function migrateLegacyHiddenCodexHome(homeDir, report) {
    if (String(homeDir.getName()) !== "codex-home" || homeDir.exists()) {
      return;
    }
    var parent = homeDir.getParentFile();
    if (parent === null) {
      return;
    }
    var legacy = new File(parent, ".codex-home");
    if (!legacy.isDirectory()) {
      return;
    }
    try {
      if (legacy.renameTo(homeDir)) {
        report.reused.push("legacy .codex-home migrated to codex-home");
        return;
      }
    } catch (_ignoreLegacyRename) {}
    copyDirectoryTree(legacy, homeDir);
    report.copied.push("legacy .codex-home copied to codex-home");
  }

  function projectDirectoryByName(projectName) {
    var name = trim(projectName);
    if (!name.length) {
      return null;
    }
    try {
      var manager = Packages.com.twinsoft.convertigo.engine.Engine.theApp.databaseObjectsManager;
      var project = manager.getOriginalProjectByName(name);
      if (project === null || typeof project === "undefined") {
        project = manager.getProjectByName(name);
      }
      if (project && project.getDirFile) {
        var dirFile = project.getDirFile();
        if (dirFile !== null && typeof dirFile !== "undefined") {
          return dirFile;
        }
      }
      if (project && project.getDirPath) {
        var dirPath = project.getDirPath();
        if (trim(dirPath).length) {
          return new File(String(dirPath));
        }
      }
    } catch (_ignoreProjectDirectoryByName) {}
    return null;
  }

  function numericVersionParts(value) {
    var match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(trim(value));
    if (match === null) {
      return null;
    }
    return [Number(match[1] || 0), Number(match[2] || 0), Number(match[3] || 0)];
  }

  function versionAtLeast(value, minimum) {
    var actual = numericVersionParts(value);
    var required = numericVersionParts(minimum);
    if (actual === null || required === null) {
      return false;
    }
    for (var i = 0; i < 3; i++) {
      if (actual[i] !== required[i]) {
        return actual[i] > required[i];
      }
    }
    return true;
  }

  function engineProductVersion() {
    try {
      return trim(Packages.com.twinsoft.convertigo.engine.Version.version);
    } catch (_ignoreEngineProductVersion) {
      return "";
    }
  }

  function flowCapabilityAvailability() {
    var engineVersion = engineProductVersion();
    var versionSupported = versionAtLeast(engineVersion, FLOW_MINIMUM_CONVERTIGO_VERSION);
    if (!versionSupported) {
      return {
        available: false,
        engineVersion: engineVersion,
        versionSupported: false,
        missingProjects: []
      };
    }
    if (flowCapabilityAvailabilityCache !== null &&
        flowCapabilityAvailabilityCache.engineVersion === engineVersion &&
        now() - flowCapabilityAvailabilityCache.checkedAt < 5000) {
      return flowCapabilityAvailabilityCache;
    }
    var missingProjects = [];
    try {
      var manager = Packages.com.twinsoft.convertigo.engine.Engine.theApp.databaseObjectsManager;
      var projectNames = manager.getAllProjectNamesList(false);
      for (var i = 0; i < FLOW_REQUIRED_PROJECTS.length; i++) {
        if (!projectNames.contains(FLOW_REQUIRED_PROJECTS[i])) {
          missingProjects.push(FLOW_REQUIRED_PROJECTS[i]);
        }
      }
    } catch (_ignoreFlowProjectInventory) {
      missingProjects = FLOW_REQUIRED_PROJECTS.slice(0);
    }
    flowCapabilityAvailabilityCache = {
      available: missingProjects.length === 0,
      engineVersion: engineVersion,
      versionSupported: true,
      missingProjects: missingProjects,
      checkedAt: now()
    };
    return flowCapabilityAvailabilityCache;
  }

  function flowCapabilityAvailable() {
    return flowCapabilityAvailability().available === true;
  }

  function callLocalSequence(project, sequence, variables) {
    var params = new HashMap();
    var projectArray = java.lang.reflect.Array.newInstance(java.lang.String, 1);
    var sequenceArray = java.lang.reflect.Array.newInstance(java.lang.String, 1);
    projectArray[0] = String(project);
    sequenceArray[0] = String(sequence);
    params.put("__project", projectArray);
    params.put("__sequence", sequenceArray);
    params.put("__context", "agentBridge_" + String(now()));
    variables = variables || {};
    for (var key in variables) {
      if (Object.prototype.hasOwnProperty.call(variables, key) && variables[key] !== null && typeof variables[key] !== "undefined") {
        params.put(String(key), String(variables[key]));
      }
    }
    var requester = null;
    try {
      requester = new InternalRequester(params, context.httpServletRequest);
    } catch (_ignoreHttpRequest) {
      requester = new InternalRequester(params);
    }
    var response = requester.processRequest();
    try {
      var json = JSON.parse(XMLUtils.XmlToJson(response.getDocumentElement(), true, true, JsonOutput.JsonRoot.docNode).toString());
      return json;
    } finally {
      try {
        var ctx2 = requester.getContext();
        Engine.theApp.contextManager.remove(ctx2);
      } catch (_ignoreContextCleanup) {}
    }
  }

  function findSetupCodexResult(value, depth) {
    if (value === null || typeof value === "undefined" || typeof value !== "object" || depth > 8) {
      return null;
    }
    if (Object.prototype.hasOwnProperty.call(value, "skillStatus") &&
        (Object.prototype.hasOwnProperty.call(value, "resolvedCodexHome") || Object.prototype.hasOwnProperty.call(value, "skillPath"))) {
      return value;
    }
    var preferred = ["setupCodexResult", "result", "document", "doc", "payload", "response"];
    for (var i = 0; i < preferred.length; i++) {
      if (Object.prototype.hasOwnProperty.call(value, preferred[i])) {
        var found = findSetupCodexResult(value[preferred[i]], depth + 1);
        if (found !== null) {
          return found;
        }
      }
    }
    for (var key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        var nested = value[key];
        if (nested !== null && typeof nested === "object") {
          var nestedFound = findSetupCodexResult(nested, depth + 1);
          if (nestedFound !== null) {
            return nestedFound;
          }
        }
      }
    }
    return null;
  }

  function findSetupVibeResult(value, depth) {
    if (value === null || typeof value === "undefined" || typeof value !== "object" || depth > 8) {
      return null;
    }
    if (Object.prototype.hasOwnProperty.call(value, "skillStatus") &&
        (Object.prototype.hasOwnProperty.call(value, "resolvedVibeHome") || Object.prototype.hasOwnProperty.call(value, "skillPath"))) {
      return value;
    }
    var preferred = ["setupVibeResult", "result", "document", "doc", "payload", "response"];
    for (var i = 0; i < preferred.length; i++) {
      if (Object.prototype.hasOwnProperty.call(value, preferred[i])) {
        var found = findSetupVibeResult(value[preferred[i]], depth + 1);
        if (found !== null) {
          return found;
        }
      }
    }
    for (var key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        var nested = value[key];
        if (nested !== null && typeof nested === "object") {
          var nestedFound = findSetupVibeResult(nested, depth + 1);
          if (nestedFound !== null) {
            return nestedFound;
          }
        }
      }
    }
    return null;
  }

  function setupVibeFromMcpProject(options, vibeHome, mcpEndpoint) {
    var setupProject = "lib_ConvertigoMCP";
    var report = {
      attempted: false,
      ok: false,
      provider: "vibe",
      source: setupProject + "._setupVibe",
      target: filePath(vibeHome),
      copied: [],
      generated: [],
      reused: [],
      warnings: [],
      skillStatus: "",
      agentsStatus: "",
      configStatus: "",
      settingsCacheInvalidated: false,
      resolvedVibeHome: filePath(vibeHome),
      resolvedMcpUrl: trim(mcpEndpoint) || resolveMcpEndpoint(options),
      skillPath: "",
      skipped: false,
      message: "",
      error: ""
    };
    if (projectDirectoryByName(setupProject) === null) {
      report.skipped = true;
      report.error = setupProject + " project not loaded";
      report.message = "Required capability project not loaded: " + setupProject;
      return report;
    }
    report.attempted = true;
    try {
      var response = callLocalSequence(setupProject, "_setupVibe", {
        vibeHome: report.resolvedVibeHome,
        mcpUrl: report.resolvedMcpUrl,
        dryRun: boolValue(options && options.dryRun, false) ? "true" : "false",
        replaceConfig: "false"
      });
      var result = findSetupVibeResult(response, 0);
      if (result === null) {
        throw new Error(setupProject + "._setupVibe did not return a setup result");
      }
      report.ok = true;
      report.skillStatus = trim(result.skillStatus) || "unknown";
      report.agentsStatus = trim(result.agentsStatus) || "unknown";
      report.configStatus = trim(result.configStatus) || "unknown";
      report.resolvedVibeHome = trim(result.resolvedVibeHome) || report.resolvedVibeHome;
      report.resolvedMcpUrl = trim(result.resolvedMcpUrl) || report.resolvedMcpUrl;
      report.skillPath = trim(result.skillPath);
      report.target = report.resolvedVibeHome;
      if (report.configStatus !== "unchanged") {
        report.settingsCacheInvalidated = invalidatePersistentProviderSettingsCache(
          resolveWorkspaceRoot(options || {}),
          "vibe",
          providerSettingsCacheKey("vibe", report.resolvedVibeHome)
        );
      }
      if (result.warnings && typeof result.warnings.length !== "undefined") {
        for (var i = 0; i < result.warnings.length; i++) {
          var warning = trim(result.warnings[i]);
          if (warning.length) {
            report.warnings.push(warning);
          }
        }
      }
      var skillEntry = "skills/convertigo-vibe-generalist/SKILL.md";
      if (report.skillStatus === "unchanged") {
        report.reused.push(skillEntry);
      } else {
        report.generated.push(skillEntry);
      }
      report.message = "Convertigo Vibe skill synchronized from " + setupProject + "._setupVibe";
    } catch (e) {
      report.error = String(e);
      report.message = "Unable to synchronize from " + setupProject + "._setupVibe";
    }
    return report;
  }

  function setupCodexFromMcpProject(options, codexHome, mcpEndpoint, profile) {
    var capabilityProfile = agentCapabilityProfile({ agentProfile: profile });
    var skillKey = capabilityProfile.setupSkillKey;
    var skillLabel = capabilityProfile.label;
    var setupProject = capabilityProfile.setupProject;
    var report = {
      attempted: false,
      ok: false,
      source: setupProject + "._setupCodex",
      skillStatus: "",
      backendSkillStatus: "",
      frontendSkillStatus: "",
      configStatus: "",
      resolvedCodexHome: filePath(codexHome),
      resolvedMcpUrl: trim(mcpEndpoint) || resolveMcpEndpoint(options),
      skillPath: "",
      backendSkillPath: "",
      frontendSkillPath: "",
      warnings: [],
      dryRun: boolValue(options.dryRun, false),
      message: "",
      error: ""
    };
    if (projectDirectoryByName(setupProject) === null) {
      report.error = setupProject + " project not loaded";
      report.message = capabilityProfile.setupRequired
        ? "Required capability project not loaded: " + setupProject
        : setupProject + " project not loaded; using bridge fallback skill generator";
      return report;
    }
    report.attempted = true;
    try {
      var response = callLocalSequence(setupProject, "_setupCodex", {
        codexHome: filePath(codexHome),
        mcpUrl: report.resolvedMcpUrl,
        dryRun: report.dryRun ? "true" : "false"
      });
      var result = findSetupCodexResult(response, 0);
      if (result === null) {
        throw new Error(setupProject + "._setupCodex did not return a setup result");
      }
      var skillInfo = skillKey.length && result.skills && result.skills[skillKey] ? result.skills[skillKey] : null;
      if (capabilityProfile.id === "nocode" && skillInfo === null) {
        throw new Error("lib_ConvertigoMCP._setupCodex did not return convertigo-nocode skill details");
      }
      var skillPaths = result.skillPaths && typeof result.skillPaths === "object" ? result.skillPaths : {};
      report.ok = true;
      report.skillStatus = trim(skillInfo && skillInfo.status) || trim(result.skillStatus) || "unknown";
      report.backendSkillStatus = trim(result.backendSkillStatus);
      report.frontendSkillStatus = trim(result.frontendSkillStatus);
      report.configStatus = trim(result.configStatus) || "unknown";
      report.resolvedCodexHome = trim(result.resolvedCodexHome) || report.resolvedCodexHome;
      report.resolvedMcpUrl = trim(result.resolvedMcpUrl) || report.resolvedMcpUrl;
      report.skillPath = trim(skillInfo && skillInfo.path) || trim(skillPaths[skillKey]) || trim(result.skillPath);
      report.backendSkillPath = trim(result.backendSkillPath);
      report.frontendSkillPath = trim(result.frontendSkillPath);
      if (result.warnings && typeof result.warnings.length !== "undefined") {
        for (var i = 0; i < result.warnings.length; i++) {
          var warning = trim(result.warnings[i]);
          if (warning.length) {
            report.warnings.push(warning);
          }
        }
      }
      report.message = skillLabel + " skill synchronized from " + setupProject + "._setupCodex";
    } catch (e) {
      report.ok = false;
      report.error = String(e);
      report.message = "Unable to synchronize from " + setupProject + "._setupCodex"
        + (capabilityProfile.setupRequired ? "" : "; using bridge fallback skill generator");
    }
    return report;
  }

  function skillGuidanceVersion(content) {
    var match = String(content == null ? "" : content).match(/^- Skill guidance version:\s*`([^`]+)`\./m);
    return match === null ? "" : trim(match[1]);
  }

  function installedSkillGuidanceVersion(skillPath) {
    var path = trim(skillPath);
    if (!path.length) {
      return "";
    }
    try {
      return skillGuidanceVersion(readTextFile(new File(path)));
    } catch (e) {
      return "";
    }
  }

  function installedProfileGuidanceVersion(codexHome, options) {
    if (codexHome === null || typeof codexHome === "undefined") {
      return "";
    }
    var skillSlug = agentCapabilityProfile(options || {}).skillSlug;
    var skillFile = new File(new File(new File(codexHome, "skills"), skillSlug), "SKILL.md");
    return installedSkillGuidanceVersion(filePath(skillFile));
  }

  function mcpSkillSourceCandidate(options) {
    var explicit = trim(options.mcpSkillsSourceDir || options.skillsSourceDir || options.convertigoMcpDir);
    if (explicit.length) {
      return new File(explicit);
    }
    var projectDir = projectDirectoryByName("lib_ConvertigoMCP");
    if (projectDir !== null) {
      return projectDir;
    }
    var home = String(System.getProperty("user.home"));
    var candidates = [
      new File(home, "git/c8oprj-lib-c8o-mcp"),
      new File(home, "git/c8oprj-convertigo-mcp")
    ];
    for (var i = 0; i < candidates.length; i++) {
      if (isMcpSkillSource(candidates[i])) {
        return candidates[i];
      }
    }
    return null;
  }

  function isMcpSkillSource(dir) {
    return dir !== null && dir.exists() && dir.isDirectory() &&
      new File(dir, "AGENT.md").isFile() &&
      new File(dir, "TOOLS.md").isFile();
  }

  function shouldCopySkillFile(file) {
    var name = String(file.getName());
    if (name === "AGENT.md" || name === "TOOLS.md" || name === "SKILL.md") {
      return true;
    }
    return name.toLowerCase().lastIndexOf(".md") === name.length - 3;
  }

  function copySkillTree(source, target, relative, report) {
    var sourceEntry = new File(source, relative);
    if (!sourceEntry.exists()) {
      return;
    }
    if (sourceEntry.isFile()) {
      if (shouldCopySkillFile(sourceEntry)) {
        var destination = new File(target, relative);
        writeTextFile(destination, readTextFile(sourceEntry));
        report.copied.push(relative);
      }
      return;
    }
    if (!sourceEntry.isDirectory()) {
      return;
    }
    var children = sourceEntry.listFiles();
    if (children === null) {
      return;
    }
    for (var i = 0; i < children.length; i++) {
      var child = children[i];
      var childRelative = relative.length ? relative + "/" + child.getName() : String(child.getName());
      if (child.isDirectory()) {
        copySkillTree(source, target, childRelative, report);
      } else if (shouldCopySkillFile(child)) {
        var destination = new File(target, childRelative);
        writeTextFile(destination, readTextFile(child));
        report.copied.push(childRelative);
      }
    }
  }

  function noCodeSkillSourceFile(options) {
    options = options || {};
    var candidates = [];
    var explicit = trim(options.mcpSkillsSourceDir || options.skillsSourceDir || options.convertigoMcpDir);
    if (explicit.length) {
      var explicitFile = new File(explicit);
      candidates.push(new File(explicitFile, "SKILL.md"));
      candidates.push(new File(new File(explicitFile, "convertigo-nocode"), "SKILL.md"));
      candidates.push(new File(new File(new File(explicitFile, "resources"), "convertigo-nocode"), "SKILL.md"));
    }
    var sourceRoot = mcpSkillSourceCandidate(options);
    if (sourceRoot !== null) {
      candidates.push(new File(new File(new File(sourceRoot, "resources"), "convertigo-nocode"), "SKILL.md"));
    }
    var home = String(System.getProperty("user.home"));
    candidates.push(new File(home, "git/c8oprj-lib-c8o-mcp/resources/convertigo-nocode/SKILL.md"));
    candidates.push(new File(home, "git/c8oprj-convertigo-mcp/resources/convertigo-nocode/SKILL.md"));
    for (var i = 0; i < candidates.length; i++) {
      var file = candidates[i];
      if (file !== null && file.isFile()) {
        return file;
      }
    }
    return null;
  }

  function flowSkillSourceFile(options, skillSlug) {
    options = options || {};
    skillSlug = trim(skillSlug) || "convertigo-flow-mcp";
    var candidates = [];
    var explicit = trim(options.flowSkillsSourceDir || options.skillsSourceDir || options.flowMcpDir);
    if (explicit.length) {
      var explicitFile = new File(explicit);
      if (skillSlug === "convertigo-flow-mcp") {
        candidates.push(new File(explicitFile, "SKILL.md"));
      }
      candidates.push(new File(new File(explicitFile, skillSlug), "SKILL.md"));
      candidates.push(new File(new File(new File(new File(explicitFile, "libs"), "flow"), "resources"), "skills/" + skillSlug + "/SKILL.md"));
    }
    var projectDir = projectDirectoryByName("lib_flow_mcp");
    if (projectDir !== null) {
      candidates.push(new File(projectDir, "libs/flow/resources/skills/" + skillSlug + "/SKILL.md"));
    }
    var home = String(System.getProperty("user.home"));
    candidates.push(new File(home, "git/lib_flow_mcp/libs/flow/resources/skills/" + skillSlug + "/SKILL.md"));
    for (var i = 0; i < candidates.length; i++) {
      if (candidates[i] !== null && candidates[i].isFile()) {
        return candidates[i];
      }
    }
    return null;
  }

  function normalizeNoCodeSkillContent(content, mcpEndpoint) {
    var text = String(content == null ? "" : content);
    var versionLine = "- Skill guidance version: `" + MCP_GUIDANCE_VERSION + "`.";
    var endpointLine = "- Expected MCP endpoint: `" + trim(mcpEndpoint) + "`.";
    if (/^- Skill guidance version: `[^`]*`\./m.test(text)) {
      text = text.replace(/^- Skill guidance version: `[^`]*`\./m, versionLine);
    }
    if (/^- Expected MCP endpoint: `[^`]*`\./m.test(text)) {
      text = text.replace(/^- Expected MCP endpoint: `[^`]*`\./m, endpointLine);
    }
    return text;
  }

  function managedSkillContent(options, profile, mcpEndpoint) {
    var capabilityProfile = agentCapabilityProfile({ agentProfile: profile });
    if (capabilityProfile.id === "flow") {
      var flowFile = flowSkillSourceFile(options);
      if (flowFile !== null) {
        return {
          content: readTextFile(flowFile),
          source: filePath(flowFile),
          copied: true
        };
      }
      return {
        content: "",
        source: "",
        copied: false,
        missing: true
      };
    }
    if (capabilityProfile.id === "nocode") {
      var noCodeFile = noCodeSkillSourceFile(options);
      if (noCodeFile !== null) {
        return {
          content: normalizeNoCodeSkillContent(readTextFile(noCodeFile), mcpEndpoint),
          source: filePath(noCodeFile),
          copied: true
        };
      }
      return {
        content: buildConvertigoNoCodeSkill(mcpEndpoint),
        source: "generated fallback",
        copied: false
      };
    }
    return {
      content: buildConvertigoGeneralistSkill(mcpEndpoint),
      source: "generated",
      copied: false
    };
  }

  function normalizeSkillProfile(options) {
    return agentCapabilityProfile(options).id;
  }

  function requestedSkillProfile(options) {
    options = options || {};
    return trim(
      optionOrRequest(options, "agentProfile") ||
      optionOrRequest(options, "skillProfile") ||
      optionOrRequest(options, "assistantContext") ||
      optionOrRequest(options, "profile")
    ).toLowerCase();
  }

  function requestedUserId(options) {
    return trim(optionOrRequest(options || {}, "userId"));
  }

  function profileByAlias(value) {
    var normalized = trim(value).toLowerCase();
    for (var id in AGENT_CAPABILITY_PROFILES) {
      if (!Object.prototype.hasOwnProperty.call(AGENT_CAPABILITY_PROFILES, id)) {
        continue;
      }
      var profile = AGENT_CAPABILITY_PROFILES[id];
      for (var i = 0; i < profile.aliases.length; i++) {
        if (normalized === profile.aliases[i]) {
          return profile;
        }
      }
    }
    return null;
  }

  function agentCapabilityProfile(options) {
    options = options || {};
    var value = requestedSkillProfile(options);
    var project = trim(
      optionOrRequest(options, "targetProject") ||
      optionOrRequest(options, "projectName") ||
      optionOrRequest(options, "projectId") ||
      optionOrRequest(options, "primaryProject") ||
      resolveProjectIdOption(options)
    );
    var explicit = profileByAlias(value);
    var userId = requestedUserId(options);
    if (userId.length && userId.toLowerCase() !== "studio") {
      return AGENT_CAPABILITY_PROFILES.nocode;
    }
    if (userId.toLowerCase() === "studio" && explicit === AGENT_CAPABILITY_PROFILES.nocode) {
      explicit = null;
    }
    if (explicit === AGENT_CAPABILITY_PROFILES.flow && !flowCapabilityAvailable()) {
      explicit = null;
    }
    if (explicit !== null) {
      return explicit;
    }
    if (!value.length && projectUsesFlow(project)) {
      return AGENT_CAPABILITY_PROFILES.flow;
    }
    return AGENT_CAPABILITY_PROFILES.generalist;
  }

  function publicAgentCapabilityProfile(options) {
    var profile = agentCapabilityProfile(options || {});
    return {
      id: profile.id,
      label: profile.label,
      authoringPolicy: profile.authoringPolicy,
      capabilityIds: profile.capabilityIds.slice(0),
      supportedProviders: profile.supportedProviders.slice(0),
      mcpServerName: profile.mcpServerName,
      mcpPath: profile.mcpPath,
      setupProject: profile.setupProject,
      skillSlug: profile.skillSlug,
      specialistSkillSlugs: profile.specialistSkillSlugs.slice(0),
      setupRequired: profile.setupRequired === true
    };
  }

  function publicAgentCapabilityProfiles() {
    var userId = requestedUserId({});
    if (userId.length && userId.toLowerCase() !== "studio") {
      return [publicAgentCapabilityProfile({ agentProfile: "nocode", userId: userId })];
    }
    var profiles = [publicAgentCapabilityProfile({ agentProfile: "generalist", userId: "studio" })];
    if (flowCapabilityAvailable()) {
      profiles.push(publicAgentCapabilityProfile({ agentProfile: "flow", userId: "studio" }));
    }
    return profiles;
  }

  function projectUsesFlow(projectName) {
    if (!flowCapabilityAvailable()) {
      return false;
    }
    var name = trim(projectName);
    if (!name.length) {
      return false;
    }
    var dir = projectDirectoryByName(name);
    if (dir === null) {
      return false;
    }
    if (new File(dir, "libs/flow/engine.yaml").isFile()) {
      return true;
    }
    try {
      var yaml = new File(dir, "c8oProject.yaml");
      return yaml.isFile() && /\[flow\.Flow(?:Engine)?\]/.test(readTextFile(yaml));
    } catch (_ignoreFlowProjectDetection) {
      return false;
    }
  }

  function managedSkillSlug(profile) {
    return agentCapabilityProfile({ agentProfile: profile }).skillSlug;
  }

  function managedSkillLabel(profile) {
    return agentCapabilityProfile({ agentProfile: profile }).label;
  }

  function agentSkillInstructions(provider, profile) {
    var capabilityProfile = agentCapabilityProfile({ agentProfile: profile });
    var isNoCode = capabilityProfile.id === "nocode";
    var isFlow = capabilityProfile.id === "flow";
    var isVibe = normalizeProvider(provider) === "vibe";
    if (isNoCode) {
      return [
        "# Convertigo No Code Agent Instructions",
        "You are embedded in C8Oforms, not Eclipse Studio. Follow skills/convertigo-nocode/SKILL.md before working.",
        "Use only nocode-form-* and nocode-baserow-* tools allowed by that skill, plus log-view for narrowly scoped diagnostics.",
        "Never fall back to requestable-execute, databaseobject-*, project tools, batch wrappers, shell, raw HTTP, or filesystem access to read or modify forms.",
        "Read an existing form with nocode-form-get using its document id before auditing, proposing improvements, or editing. Tool names may use underscores instead of hyphens.",
        "Use the current form/page/element context as the default target. Never infer content from the form name alone. Read results describe the saved version, not unsaved editor changes.",
        "A review or request for suggestions does not authorize mutations. Never use an empty edit/update as a read operation.",
        "Authentication is supplied by the host. Never request, read, expose, or print credentials. On auth_required ask the user to reconnect; on form_unavailable explain that the form is missing or inaccessible without claiming a proven permission denial.",
        "If the required no-code tool is unavailable, report the missing capability without bypassing it.",
        "Use semantic nocode-form-edit operations for authorized edits. Preserve unrelated fields, pages and sources.",
        "Pass reveal:true only to supported mutation tools when the host requests reveal. Never add it to a read.",
        "Reply in the user's language, with short factual progress updates.",
        "Provider: " + providerLabel(provider)
      ].join("\n");
    }
    return [
      "# Convertigo Agent Instructions",
      "",
      "You are running inside a Convertigo-integrated local agent session.",
      "",
      "- Active authoring policy: `" + capabilityProfile.authoringPolicy + "` (" + capabilityProfile.label + ").",
      isFlow ? "- Follow the managed Flow capability pack for project inspection, mutation, viewer startup, synchronization, and validation. It owns the current MCP tool names and workflow." : (isNoCode ? "- Automatically follow the Convertigo NoCode workflow for C8Oforms / No-Code Studio work." : "- Automatically follow the Convertigo Generalist workflow for Convertigo project work."),
      isFlow ? "- Do not use the legacy Convertigo MCP surface while this flow-only policy is active." : "- Use the Convertigo MCP/tools whenever you need to inspect, modify, save, reload, or validate Convertigo projects.",
      isFlow ? "- Start viewer preparation asynchronously through the capability pack, continue authoring while it warms up, and use its readiness contract for final acceptance." : "- When `mobile-builder-open` returns `browserDebugUrl`, `browserDevToolsJsonUrl`, or `browserDevToolsWebSocketUrl`, treat it as the visible Studio mobile viewer and prefer inspecting or driving that viewer over opening a separate browser.",
      isFlow ? "- After the first frontend read of every turn, call the idempotent `dev.ensure` action with `wait:false` before mutation so a resumed conversation repairs a stopped viewer immediately." : "",
      isFlow ? "- Import generated or supplied images with `frontend-svelte-asset-import`, use its returned `resources/...` URL unchanged, and never copy assets with shell commands or into generated static folders." : "",
      isFlow ? "" : "- If `mobile-builder-open(stateOnly=true)` returns `status:\"stopped\"`, immediately call it once with `stateOnly=false, wait=false`; do not spend a timeout polling an inactive builder.",
      "- Studio JxBrowser exposes one existing visible page over CDP, not a normal multi-tab browser. Reuse it and do not create, open, close, select, or navigate tabs/pages.",
      "- For viewer automation, use the Playwright MCP tools exposed by the managed Codex configuration. Do not run ad hoc shell scripts with `require('playwright')`, and do not launch a separate browser unless explicitly needed.",
      isFlow ? "- Use Playwright only after the capability pack reports that the dev viewer is ready and the managed browser target shows that viewer." : "- Use Playwright only after `mobile-builder-open` reports both `browserDebugPortMatched:true` and `browserControlReady:true`.",
      "- Known-good fast check: `playwright.browser_tabs({action:\"list\"})`, then `playwright.browser_find({text:\"<visible text>\"})`; use `playwright.browser_evaluate({function:\"...\"})` only for DOM state or timing. Do not probe unsupported browser features first.",
      isFlow ? "- If the browser target is `about:blank`, use the capability pack readiness contract before browser proof." : "- If the browser target is `about:blank` while builder status is `building`, poll `mobile-builder-open(stateOnly=true, wait=true)` before Playwright. If status is `stopped`, launch asynchronously instead.",
      isFlow ? "- If Playwright is unavailable, disabled, still on `about:blank`, or attached to another endpoint, report the host configuration problem instead of bypassing it." : "- If `mobile-builder-open` reports `browserControlReady:true` but the Playwright/browser-control MCP tools are unavailable, disabled, still on `about:blank`, or attached to another endpoint, report the configuration problem to the user instead of bypassing it with Node scripts, raw CDP WebSocket code, or a new browser.",
      "- If a prompt says Convertigo runtime reveal mode is enabled, pass `reveal:true` only on supported Convertigo mutation/viewer tools that should visibly move Studio or No Code Studio; do not add it to read-only calls.",
      isFlow ? "- Keep viewer starts and synchronization asynchronous until the final acceptance proof." : "- For `mobile-builder-open`, use `wait:false` for reveal/focus polls; reserve long `wait:true` calls for readiness proof and omit `reveal` unless the user specifically needs UI focus.",
      isVibe ? "- Treat the Convertigo MCP transport as serial: issue exactly one Convertigo MCP tool call per assistant message, including reads. Never group Convertigo tool calls in one response." : "",
      isVibe ? "- Do not wait with shell `sleep` or PowerShell delays. After one asynchronous builder launch and useful mutations, use one serial waited `mobile-builder-open` readiness call with a sufficient timeout." : "",
      "- If those mutations are grouped with `batch-call`, pass top-level `reveal:true`; the batch reveals the final touched object after its deferred refresh.",
      isNoCode ? "- You are in the C8Oforms / No-Code Studio surface, not in Eclipse Studio. A selected Convertigo project is optional in this surface." : "- Work on the selected project unless the user explicitly asks for another project.",
      isNoCode ? "" : "- If no project is selected and the user explicitly asks to create a new project or application, derive a concise valid technical name when needed, check for collisions through Convertigo MCP, and proceed without asking for a project selection.",
      isNoCode ? "- Discover forms, applications, pages, data sources, roles, publication state, and permissions through the NoCode/C8Oforms MCP context before falling back to generic Studio project inspection." : "",
      isNoCode ? "- If the current NoCode URL, form id, route, or page id is supplied in the prompt, treat it as the default target for edits unless the user names another target." : "",
      isNoCode ? "- If a first tool discovery attempt does not show `nocode-form-*` tools, retry with exact searches for `Convertigo NoCode form contract get edit update validate compile C8Oforms`, `nocode-form-contract-get nocode-form-edit nocode-form-update`, and `mcp__convertigo nocode_form_contract_get nocode_form_edit nocode_form_update` before reporting a blocker." : "",
      isNoCode ? "- If no no-code form/application is selected, answer from the C8Oforms workspace or ask which form/application to target; do not assume an unrelated Studio project." : "",
      isFlow ? "- Never use curl, handwritten JSON-RPC, filesystem mutation, or another MCP surface as a fallback. A missing managed Flow capability is a host configuration defect." : "",
      "- Prefer Convertigo objects and MCP operations. Do not edit generated folders such as `_private/ionic`, `_private/svelte`, `DisplayObjects`, `dist`, or build outputs.",
      "- Convertigo project descriptors are MCP-owned: never read or edit `c8oProject.yaml`, `_c8oProject/**/*.yaml`, or `project.xml` to implement a project change. If a required Convertigo MCP call still fails after one targeted retry, stop and report the MCP error without changing project files.",
      "- Reply to the user in their language. Keep progress updates short and factual, and never expose hidden reasoning.",
      "- When you change a project, validate the result with the available Convertigo tools before claiming completion.",
      isNoCode ? "- Keep the user-facing vocabulary no-code oriented: forms, applications, pages, fields, data sources, roles, publication, and permissions." : "",
      "",
      isFlow ? "The managed Flow skill is available in `skills/" + capabilityProfile.skillSlug + "/SKILL.md`. Use its resources instead of the legacy Convertigo knowledge pack." : (isVibe ? "The managed Vibe skill is available in `skills/convertigo-vibe-generalist/SKILL.md`." : "The synchronized Convertigo MCP knowledge pack is available in `skills/convertigo-mcp/`."),
      isFlow ? "For delegated work, reuse the persistent backend and frontend specialists described by that skill rather than spawning a new agent per lot." : (isVibe ? "Start with `skills/convertigo-vibe-generalist/SKILL.md`, then read only the exact MCP guide required by the task." : "Start with `skills/convertigo-mcp/AGENT.md` and `skills/convertigo-mcp/TOOLS.md`, then read only the prompt or resource files relevant to the task."),
      isNoCode ? "The managed NoCode skill is available in `skills/convertigo-nocode/SKILL.md` and should be preferred for this surface." : "",
      "",
      "Provider: " + providerLabel(provider)
    ].filter(function(line) { return line !== ""; }).join("\n");
  }

  function defaultCodexHomePath() {
    return childPath(String(System.getProperty("user.home")), ".codex");
  }

  function effectiveCodexHomePath(homePath) {
    var home = trim(homePath);
    return home.length ? home : defaultCodexHomePath();
  }

  function tomlEscape(value) {
    return String(value == null ? "" : value)
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"');
  }

  function splitTextLines(text) {
    return String(text == null ? "" : text).replace(/\r\n?/g, "\n").split("\n");
  }

  function findTomlSectionRange(lines, sectionName) {
    var header = "[" + sectionName + "]";
    var start = -1;
    var end = lines.length;
    for (var i = 0; i < lines.length; i++) {
      if (trim(lines[i]) === header) {
        start = i;
        break;
      }
    }
    if (start < 0) {
      return { found: false, start: -1, end: -1 };
    }
    for (var j = start + 1; j < lines.length; j++) {
      if (/^\s*\[.+\]\s*$/.test(lines[j])) {
        end = j;
        break;
      }
    }
    return { found: true, start: start, end: end };
  }

  function serverSecretGet(handle) {
    var text = trim(handle);
    if (!text.length) {
      return "";
    }
    try {
      var store = getServerStore();
      if (store !== null && store.get) {
        var value = store.get(text);
        return value === null || typeof value === "undefined" ? "" : trim(value);
      }
    } catch (_ignoreServerSecretGet) {}
    return "";
  }

  function noCodeMcpBearerToken(options) {
    options = options || {};
    if (normalizeSkillProfile(options) !== "nocode") {
      return "";
    }
    var direct = trim(options.nocodeMcpToken || options.noCodeMcpToken || options.mcpBearerToken);
    if (direct.length) {
      return direct;
    }
    var fromHandle = serverSecretGet(options.nocodeMcpTokenHandle || options.noCodeMcpTokenHandle || options.mcpBearerTokenHandle);
    if (fromHandle.length) {
      return fromHandle;
    }
    return noCodeMcpBearerTokenFromFile(options);
  }

  function managedMcpBearerToken(options) {
    options = options || {};
    if (normalizeSkillProfile(options) === "nocode") {
      return noCodeMcpBearerToken(options);
    }
    var direct = trim(options.mcpBearerToken);
    var stored = direct.length ? direct : serverSecretGet(options.mcpBearerTokenHandle);
    try {
      var previousBundle = JSON.parse(stored);
      if (previousBundle && typeof previousBundle === "object") {
        return trim(previousBundle.legacy || previousBundle.mcp || previousBundle.flow || previousBundle.flowMcp);
      }
    } catch (_notPreviousTokenBundle) {}
    return stored;
  }

  function mcpBearerTokenEnv(options) {
    return normalizeSkillProfile(options || {}) === "nocode" ? NOCODE_MCP_TOKEN_ENV : MCP_TOKEN_ENV;
  }

  function mcpBearerTokenFingerprint(options) {
    var token = managedMcpBearerToken(options || {});
    return token.length ? hashShort(token) : "";
  }

  function usesProtectedConvertigoMcp(mcpEndpoint, options) {
    return /\/api\/(?:flow-)?mcp\/?(?:[?#].*)?$/i.test(trim(mcpEndpoint));
  }

  function applyManagedMcpEnvironment(env, options) {
    var token = managedMcpBearerToken(options || {});
    if (token.length) {
      env[mcpBearerTokenEnv(options)] = token;
    }
    return env;
  }

  function noCodeMcpBearerTokenFromFile(options) {
    options = options || {};
    var userId = trim(optionOrRequest(options, "userId"));
    if (!userId.length) {
      return "";
    }
    try {
      var tokenFile = new File(new File(new File(new File(resolveWorkspaceRoot(options), "agents"), "nocode"), "users"), userPathSlug(userId));
      tokenFile = new File(tokenFile, "mcp-token.json");
      if (!tokenFile.isFile()) {
        return "";
      }
      var record = JSON.parse(readTextFile(tokenFile));
      return trim(record && record.token);
    } catch (_ignoreNoCodeTokenFile) {
      return "";
    }
  }

  function tomlArray(values) {
    var parts = [];
    for (var i = 0; i < values.length; i++) {
      parts.push('"' + tomlEscape(values[i]) + '"');
    }
    return "[" + parts.join(", ") + "]";
  }

  function removeTomlSection(lines, sectionName) {
    var range = findTomlSectionRange(lines, sectionName);
    if (!range.found) {
      return {
        lines: lines,
        removed: false
      };
    }
    return {
      lines: lines.slice(0, range.start).concat(lines.slice(range.end)),
      removed: true
    };
  }

  function removeTrailingPlaywrightConfigComments(lines) {
    lines = lines || [];
    var retained = [];
    for (var i = 0; i < lines.length; i++) {
      var line = trim(lines[i]);
      if (line === "# The Studio JxBrowser CDP endpoint is supplied by the Codex process environment." ||
          line === "# Do not hardcode it here; several conversations may target different builders." ||
          line === "# The Studio JxBrowser CDP endpoint is scoped to this Codex home and refreshed per conversation." ||
          line === "# This scoped home may target a different builder than another conversation." ||
          line === "# The Studio JxBrowser CDP endpoint is written here because this Codex home is viewer-scoped." ||
          line === "# If a shared/user home is forced, Playwright MCP stays disabled to avoid opening an external browser.") {
        continue;
      }
      retained.push(lines[i]);
    }
    return retained;
  }

  function npmPackageNameFromSpec(spec) {
    var text = trim(spec);
    if (!text.length) {
      return "";
    }
    var slash = text.indexOf("/");
    var at = text.lastIndexOf("@");
    if (at > 0 && at > slash) {
      return text.substring(0, at);
    }
    return text;
  }

  function resolvePlaywrightMcpCdpEndpoint(options) {
    options = options || {};
    var viewerDebugPort = intValue(options.viewerDebugPort, 0, 0, 65535);
    if (viewerDebugPort >= 1024) {
      return "http://127.0.0.1:" + viewerDebugPort;
    }
    var endpoint = trim(
      options.playwrightCdpEndpoint ||
      options.viewerCdpEndpoint ||
      options.browserDebugUrl ||
      options.browserDevToolsWebSocketUrl ||
      options.browserDevToolsJsonUrl ||
      options.playwrightMcpEndpoint
    );
    if (endpoint.match(/\/json\/?$/)) {
      return endpoint.replace(/\/json\/?$/, "");
    }
    return endpoint;
  }

  function viewerDebugPortLeaseFile(options) {
    options = options || {};
    var conversationId = trim(options.conversationId || options.threadid || options.handle);
    if (!conversationId.length) {
      return null;
    }
    var root = new File(new File(new File(resolveWorkspaceRoot(options), "agents"), "codex"), "viewer-debug-ports");
    return new File(root, safePathPart(conversationId) + ".json");
  }

  function stableViewerDebugPortBase(value) {
    var text = String(value || "");
    var hash = 0;
    for (var i = 0; i < text.length; i++) {
      hash = ((hash * 31) + text.charCodeAt(i)) & 0x7fffffff;
    }
    return 40000 + (hash % 10000);
  }

  function leasedViewerDebugPorts(leaseFile) {
    var used = {};
    if (leaseFile === null || leaseFile.getParentFile() === null || !leaseFile.getParentFile().isDirectory()) {
      return used;
    }
    var currentPath = filePath(leaseFile);
    var files = leaseFile.getParentFile().listFiles();
    if (files === null) {
      return used;
    }
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      if (!file.isFile() || filePath(file) === currentPath) {
        continue;
      }
      try {
        var lease = parseObject(readTextFile(file), {});
        var port = intValue(lease.port, 0, 0, 65535);
        if (port >= 1024) {
          used[String(port)] = true;
        }
      } catch (_ignoreViewerDebugPortLease) {}
    }
    return used;
  }

  function ensureManagedViewerDebugPort(options) {
    options = options || {};
    var explicitPort = intValue(options.viewerDebugPort, 0, 0, 65535);
    if (explicitPort >= 1024) {
      options.viewerDebugPort = explicitPort;
      return explicitPort;
    }
    if (boolValue(options.disableViewerDebugPortReservation || options.skipViewerDebugPortReservation, false)) {
      return 0;
    }
    if (normalizeSkillProfile(options) === "nocode") {
      return 0;
    }
    var leaseFile = viewerDebugPortLeaseFile(options);
    if (leaseFile === null) {
      return 0;
    }
    var leasedPorts = leasedViewerDebugPorts(leaseFile);
    try {
      if (leaseFile.isFile()) {
        var lease = parseObject(readTextFile(leaseFile), {});
        var leasedPort = intValue(lease.port, 0, 0, 65535);
        if (leasedPort >= 1024 && leasedPorts[String(leasedPort)] !== true) {
          options.viewerDebugPort = leasedPort;
          return leasedPort;
        }
      }
    } catch (_ignoreViewerDebugPortLeaseRead) {}

    var conversationId = trim(options.conversationId || options.threadid || options.handle);
    var basePort = stableViewerDebugPortBase(conversationId);
    var port = 0;
    for (var offset = 0; offset < 10000; offset++) {
      var candidate = 40000 + ((basePort - 40000 + offset) % 10000);
      if (leasedPorts[String(candidate)] !== true && Number(NetworkUtils.nextAvailable(candidate)) === candidate) {
        port = candidate;
        break;
      }
    }
    if (port < 1024 || port > 65535) {
      throw new Error("Unable to reserve a Studio viewer debug port");
    }
    ensureDirectory(leaseFile.getParentFile());
    writeTextFile(leaseFile, JSON.stringify({
      conversationId: conversationId,
      port: port,
      createdAt: now()
    }, null, 2) + "\n");
    options.viewerDebugPort = port;
    return port;
  }

  function codexPlaywrightMcpPackageSpec(options) {
    options = options || {};
    var name = trim(
      options.codexPlaywrightMcpPackage ||
      options.playwrightMcpPackage ||
      options.codexPlaywrightPackage ||
      options.playwrightPackage
    ) || "@playwright/mcp";
    var version = trim(
      options.codexPlaywrightMcpVersion ||
      options.playwrightMcpVersion ||
      options.codexPlaywrightVersion ||
      options.playwrightVersion
    ) || "latest";
    if (!version.length) {
      return name;
    }
    return name + "@" + version;
  }

  function codexPlaywrightMcpBinaryName(options) {
    return trim(options && (options.codexPlaywrightMcpBinary || options.playwrightMcpBinary)) || "playwright-mcp";
  }

  function detectNpxRuntime(options) {
    options = options || {};
    var workspaceRoot = resolveWorkspaceRoot(options);
    var userHome = String(System.getProperty("user.home"));
    var localNodeDir = normalizeDirectory(options.nodeDir || options.nodeInstallDir, filePath(ProcessUtils.getDefaultNodeDir()), workspaceRoot);
    var npxName = scriptCommandName("npx");
    var candidates = [
      trim(options.npxPath),
      childPath(localNodeDir, npxName),
      childPath(childPath(localNodeDir, "bin"), npxName)
    ];
    try {
      var npmRuntime = detectNpmRuntime(options);
      if (npmRuntime.npm && npmRuntime.npm.found) {
        var npmParent = parentPath(npmRuntime.npm.path);
        if (npmParent.length) {
          candidates.push(childPath(npmParent, npxName));
          candidates.push(childPath(parentPath(npmParent), npxName));
        }
      }
    } catch (_ignoreNpxNpmCandidate) {}
    candidates.push(childPath(childPath(userHome, ".local"), "bin/" + npxName));
    candidates.push("/opt/homebrew/bin/npx");
    candidates.push("/usr/local/bin/npx");
    candidates.push("npx");
    return firstWorkingCommand(candidates, ["--version"], nodeRuntimeSearchPath(options));
  }

  function detectNpxRuntimePresence(options) {
    options = options || {};
    var workspaceRoot = resolveWorkspaceRoot(options);
    var userHome = String(System.getProperty("user.home"));
    var localNodeDir = normalizeDirectory(options.nodeDir || options.nodeInstallDir, filePath(ProcessUtils.getDefaultNodeDir()), workspaceRoot);
    var npxName = scriptCommandName("npx");
    return firstExistingCommand([
      trim(options.npxPath),
      childPath(localNodeDir, npxName),
      childPath(childPath(localNodeDir, "bin"), npxName),
      childPath(childPath(userHome, ".local"), "bin/" + npxName),
      "/opt/homebrew/bin/" + npxName,
      "/usr/local/bin/" + npxName,
      npxName
    ], nodeRuntimeSearchPath(options));
  }

  function codexPlaywrightMcpCommand(options, installDir) {
    var npx = detectNpxRuntimePresence(options || {});
    return npx.found ? npx.path : "npx";
  }

  function playwrightMcpDirectLaunch(options, installDir) {
    // Prefer `node <prefix>/node_modules/@playwright/mcp/cli.js`: Vibe (Python asyncio)
    // and Claude Code spawn stdio MCP servers without a shell, so the npx `.cmd`
    // shim fails on Windows ([WinError 2]) and the launcher shebang is not honoured.
    options = options || {};
    var cli = new File(childPath(childPath(codexNodeModulesPath(installDir), "@playwright/mcp"), "cli.js"));
    if (!cli.isFile()) {
      return null;
    }
    var node = detectNodeRuntime(options);
    if (!node.found) {
      return null;
    }
    return {
      command: node.path,
      args: [filePath(cli), "--cdp-endpoint", resolvePlaywrightMcpCdpEndpoint(options), "--shared-browser-context"]
    };
  }

  function codexPlaywrightMcpInlineCdpEndpointEnabled(options) {
    options = options || {};
    if (!resolvePlaywrightMcpCdpEndpoint(options).length) {
      return false;
    }
    if (boolValue(options.disablePlaywrightMcpCdpEndpoint || options.skipPlaywrightMcpCdpEndpoint, false)) {
      return false;
    }
    if (boolValue(options.inlinePlaywrightMcpCdpEndpoint || options.hardcodePlaywrightMcpCdpEndpoint, false)) {
      return true;
    }
    if (trim(options.codexHome || options.agentHome).length) {
      return true;
    }
    var scopeOption = trim(options.codexHomeScope || options.homeScope || options.scope);
    if (!scopeOption.length) {
      return true;
    }
    return normalizeCodexHomeScope(scopeOption) === "conversation";
  }

  function codexPlaywrightMcpArgs(options, installDir) {
    options = options || {};
    var args = ["--prefix", codexNpmPrefix(installDir), codexPlaywrightMcpBinaryName(options)];
    var endpoint = resolvePlaywrightMcpCdpEndpoint(options);
    if (endpoint.length && codexPlaywrightMcpInlineCdpEndpointEnabled(options)) {
      args.push("--cdp-endpoint");
      args.push(endpoint);
      args.push("--shared-browser-context");
    }
    return args;
  }

  function patchCodexPlaywrightMcpConfigText(existingText, options, installDir) {
    options = options || {};
    var text = String(existingText == null ? "" : existingText).replace(/\r\n?/g, "\n");
    var lines = trim(text).length ? splitTextLines(text) : [];
    var removed = removeTomlSection(lines, "mcp_servers.playwright");
    lines = removeTrailingPlaywrightConfigComments(removed.lines);
    var endpoint = resolvePlaywrightMcpCdpEndpoint(options);
    var scopedEndpoint = codexPlaywrightMcpInlineCdpEndpointEnabled(options);
    var enabled = endpoint.length > 0 && scopedEndpoint && !boolValue(options.disablePlaywrightMcp || options.skipPlaywrightMcpConfig, false);
    if (typeof options.playwrightMcpEnabled !== "undefined" && trim(options.playwrightMcpEnabled).length) {
      enabled = boolValue(options.playwrightMcpEnabled, enabled);
    }
    if (lines.length && trim(lines[lines.length - 1]).length) {
      lines.push("");
    }
    if (enabled) {
      lines.push("# The Studio JxBrowser CDP endpoint is written here because this Codex home is viewer-scoped.");
      lines.push("# If a shared/user home is forced, Playwright MCP stays disabled to avoid opening an external browser.");
    }
    lines.push("[mcp_servers.playwright]");
    lines.push('command = "' + tomlEscape(codexPlaywrightMcpCommand(options, installDir)) + '"');
    lines.push("args = " + tomlArray(codexPlaywrightMcpArgs(options, installDir)));
    lines.push("startup_timeout_sec = 30");
    lines.push("enabled = " + (enabled ? "true" : "false"));
    var nextText = lines.join("\n").replace(/\n+$/, "\n");
    return {
      status: nextText === text.replace(/\n+$/, "\n") ? "unchanged" : (text.length ? "updated" : "created"),
      text: nextText,
      enabled: enabled,
      endpoint: endpoint
    };
  }

  function codexSkillGuidanceVersion(homePath, options) {
    var home = trim(homePath);
    if (!home.length) {
      return MCP_GUIDANCE_VERSION;
    }
    var preferred = managedSkillSlug(normalizeSkillProfile(options || {}));
    var slugs = [preferred, "convertigo-generalist", "convertigo-nocode"];
    var seen = {};
    for (var i = 0; i < slugs.length; i++) {
      var slug = trim(slugs[i]);
      if (!slug.length || seen[slug]) {
        continue;
      }
      seen[slug] = true;
      var skillFile = new File(new File(new File(home), "skills"), slug + File.separator + "SKILL.md");
      var source = readTextFile(skillFile);
      var match = /^- Skill guidance version:\s*`([^`]+)`\./m.exec(source);
      if (match !== null && trim(match[1]).length) {
        return trim(match[1]);
      }
    }
    return MCP_GUIDANCE_VERSION;
  }

  function patchCodexMcpConfigText(existingText, mcpEndpoint, options, homePath) {
    options = options || {};
    var text = String(existingText == null ? "" : existingText).replace(/\r\n?/g, "\n");
    var lines = trim(text).length ? splitTextLines(text) : [];
    var serverName = managedMcpServerName(options);
    var sectionName = "mcp_servers." + serverName;
    var headersSectionName = sectionName + ".http_headers";
    var headersRange = findTomlSectionRange(lines, headersSectionName);
    var inheritedHeaderEntries = [];
    var status = "unchanged";
    if (headersRange.found) {
      for (var headerIndex = headersRange.start + 1; headerIndex < headersRange.end; headerIndex++) {
        if (/^\s*(?:["'][^"']+["']|[A-Za-z0-9_.-]+)\s*=/.test(lines[headerIndex])) {
          inheritedHeaderEntries.push(trim(lines[headerIndex]));
        }
      }
      lines = lines.slice(0, headersRange.start).concat(lines.slice(headersRange.end));
      status = "updated";
    }
    var range = findTomlSectionRange(lines, sectionName);
    var urlLine = 'url = "' + tomlEscape(managedMcpTransportEndpoint(mcpEndpoint)) + '"';
    var timeoutLine = "startup_timeout_sec = 60";
    var enabledLine = "enabled = true";
    var guidanceHeaderEntry = '"X-Convertigo-Guidance-Version" = "' + tomlEscape(codexSkillGuidanceVersion(homePath, options)) + '"';
    var noCodeProfileHeaderEntry = normalizeSkillProfile(options) === "nocode"
      ? '"X-Convertigo-Agent-Profile" = "nocode"' : "";
    var revealModeHeaderEntry = revealModeEnabled(options, null)
      ? '"X-Convertigo-Reveal-Mode" = "true"'
      : "";
    var noLogHeaderEntry = mcpNoLogEnabled(options) ? '"X-Convertigo-No-Log" = "true"' : "";
    var viewerDebugPort = intValue(options.viewerDebugPort, 0, 0, 65535);
    var viewerDebugPortHeaderEntry = viewerDebugPort >= 1024
      ? '"X-Convertigo-Viewer-Debug-Port" = "' + tomlEscape(String(viewerDebugPort)) + '"'
      : "";
    var mcpSessionCookie = trim(options.mcpSessionCookie);
    var mcpSessionCookieHeaderEntry = mcpSessionCookie.length
      ? '"Cookie" = "' + tomlEscape(mcpSessionCookie) + '"'
      : "";
    var useBearer = usesProtectedConvertigoMcp(mcpEndpoint, options);
    var bearerLine = 'bearer_token_env_var = "' + tomlEscape(mcpBearerTokenEnv(options)) + '"';

    var headerEntryKey = function (entry) {
      var match = /^\s*([^=]+?)\s*=/.exec(String(entry || ""));
      return match === null ? "" : trim(match[1]).replace(/^["']|["']$/g, "").toLowerCase();
    };

    var mergeManagedHeaders = function (line) {
      var source = String(line || "");
      var open = source.indexOf("{");
      var close = source.lastIndexOf("}");
      var body = open < 0 || close <= open ? "" : trim(source.substring(open + 1, close));
      var existingHeaderKeys = {};
      var existingHeaderPattern = /(?:^|,)\s*([^=,]+?)\s*=/g;
      var existingHeaderMatch;
      while ((existingHeaderMatch = existingHeaderPattern.exec(body)) !== null) {
        existingHeaderKeys[trim(existingHeaderMatch[1]).replace(/^["']|["']$/g, "").toLowerCase()] = true;
      }
      for (var inheritedIndex = 0; inheritedIndex < inheritedHeaderEntries.length; inheritedIndex++) {
        var inheritedEntry = inheritedHeaderEntries[inheritedIndex];
        var inheritedKey = headerEntryKey(inheritedEntry);
        if (inheritedKey.length && existingHeaderKeys[inheritedKey] !== true) {
          body = body.length ? body + ", " + inheritedEntry : inheritedEntry;
          existingHeaderKeys[inheritedKey] = true;
        }
      }
      var guidancePattern = /(["']X-Convertigo-Guidance-Version["']\s*=\s*)["'][^"']*["']/;
      var profilePattern = /(["']X-Convertigo-Agent-Profile["']\s*=\s*)["'][^"']*["']/;
      if (profilePattern.test(body)) {
        body = body.replace(profilePattern, noCodeProfileHeaderEntry);
        body = body.replace(/^\s*,\s*|\s*,\s*$/g, "").replace(/\s*,\s*,\s*/g, ", ");
      } else if (noCodeProfileHeaderEntry.length) {
        body = body.length ? body + ", " + noCodeProfileHeaderEntry : noCodeProfileHeaderEntry;
      }
      var revealModePattern = /(["']X-Convertigo-Reveal-Mode["']\s*=\s*)["'][^"']*["']/;
      var viewerDebugPortPattern = /(["']X-Convertigo-Viewer-Debug-Port["']\s*=\s*)["'][^"']*["']/;
      var mcpSessionCookiePattern = /(["']Cookie["']\s*=\s*)["'][^"']*["']/;
      if (guidancePattern.test(body)) {
        body = body.replace(guidancePattern, guidanceHeaderEntry);
      } else {
        body = body.length ? body + ", " + guidanceHeaderEntry : guidanceHeaderEntry;
      }
      var noLogPattern = /(["']X-Convertigo-No-Log["']\s*=\s*)["'][^"']*["']/;
      if (noLogPattern.test(body)) {
        body = noLogHeaderEntry.length ? body.replace(noLogPattern, noLogHeaderEntry) : body.replace(/,?\s*["']X-Convertigo-No-Log["']\s*=\s*["'][^"']*["']/, "").replace(/^\s*,\s*/, "");
      } else if (noLogHeaderEntry.length) {
        body = body.length ? body + ", " + noLogHeaderEntry : noLogHeaderEntry;
      }
      if (viewerDebugPortHeaderEntry.length) {
        if (viewerDebugPortPattern.test(body)) {
          body = body.replace(viewerDebugPortPattern, viewerDebugPortHeaderEntry);
        } else {
          body = body.length ? body + ", " + viewerDebugPortHeaderEntry : viewerDebugPortHeaderEntry;
        }
      } else if (viewerDebugPortPattern.test(body)) {
        body = body.replace(viewerDebugPortPattern, "");
        body = body.replace(/^\s*,\s*|\s*,\s*$/g, "").replace(/\s*,\s*,\s*/g, ", ");
      }
      if (revealModeHeaderEntry.length) {
        if (revealModePattern.test(body)) {
          body = body.replace(revealModePattern, revealModeHeaderEntry);
        } else {
          body = body.length ? body + ", " + revealModeHeaderEntry : revealModeHeaderEntry;
        }
      } else if (revealModePattern.test(body)) {
        body = body.replace(revealModePattern, "");
        body = body.replace(/^\s*,\s*|\s*,\s*$/g, "").replace(/\s*,\s*,\s*/g, ", ");
      }
      if (mcpSessionCookieHeaderEntry.length) {
        if (mcpSessionCookiePattern.test(body)) {
          body = body.replace(mcpSessionCookiePattern, mcpSessionCookieHeaderEntry);
        } else {
          body = body.length ? body + ", " + mcpSessionCookieHeaderEntry : mcpSessionCookieHeaderEntry;
        }
      }
      return "http_headers = { " + body + " }";
    };
    var managedHeadersLine = mergeManagedHeaders("http_headers = { }");

    if (!range.found) {
      if (lines.length && trim(lines[lines.length - 1]).length) {
        lines.push("");
      }
      lines.push("[" + sectionName + "]");
      lines.push(urlLine);
      lines.push(timeoutLine);
      lines.push(enabledLine);
      lines.push(managedHeadersLine);
      if (useBearer) {
        lines.push(bearerLine);
      }
      status = text.length ? "updated" : "created";
      var withCreatedPlaywright = patchCodexPlaywrightMcpConfigText(lines.join("\n").replace(/\n+$/, "\n"), options, normalizeDirectory(options.installDir, childPath(resolveWorkspaceRoot(options), "agents/codex"), resolveWorkspaceRoot(options)));
      if (withCreatedPlaywright.status !== "unchanged" && status !== "created") {
        status = "updated";
      }
      return {
        status: status,
        text: withCreatedPlaywright.text
      };
    }

    var sectionLines = lines.slice(range.start, range.end);
    var replacedUrl = false;
    var replacedTimeout = false;
    var replacedEnabled = false;
    var replacedGuidanceHeaders = false;
    var replacedBearer = false;
    for (var i = 1; i < sectionLines.length; i++) {
      if (/^\s*url\s*=/.test(sectionLines[i])) {
        if (trim(sectionLines[i]) !== urlLine) {
          sectionLines[i] = urlLine;
          status = "updated";
        }
        replacedUrl = true;
        continue;
      }
      if (/^\s*startup_timeout_sec\s*=/.test(sectionLines[i])) {
        if (trim(sectionLines[i]) !== timeoutLine) {
          sectionLines[i] = timeoutLine;
          status = "updated";
        }
        replacedTimeout = true;
        continue;
      }
      if (/^\s*enabled\s*=/.test(sectionLines[i])) {
        if (trim(sectionLines[i]) !== enabledLine) {
          sectionLines[i] = enabledLine;
          status = "updated";
        }
        replacedEnabled = true;
        continue;
      }
      if (/^\s*http_headers\s*=/.test(sectionLines[i])) {
        var mergedGuidanceHeaders = mergeManagedHeaders(sectionLines[i]);
        if (trim(sectionLines[i]) !== mergedGuidanceHeaders) {
          sectionLines[i] = mergedGuidanceHeaders;
          status = "updated";
        }
        replacedGuidanceHeaders = true;
        continue;
      }
      if (/^\s*bearer_token_env_var\s*=/.test(sectionLines[i])) {
        if (useBearer) {
          if (trim(sectionLines[i]) !== bearerLine) {
            sectionLines[i] = bearerLine;
            status = "updated";
          }
          replacedBearer = true;
        } else {
          sectionLines.splice(i, 1);
          i -= 1;
          status = "updated";
        }
      }
    }
    if (!replacedUrl) {
      sectionLines.splice(1, 0, urlLine);
      status = "updated";
    }
    if (!replacedTimeout) {
      sectionLines.splice(replacedUrl ? 2 : 2, 0, timeoutLine);
      status = "updated";
    }
    if (!replacedEnabled) {
      var enabledIndex = sectionLines.length;
      for (var e = 1; e < sectionLines.length; e++) {
        if (/^\s*startup_timeout_sec\s*=/.test(sectionLines[e])) {
          enabledIndex = e + 1;
          break;
        }
      }
      sectionLines.splice(enabledIndex, 0, enabledLine);
      status = "updated";
    }
    if (!replacedGuidanceHeaders) {
      sectionLines.push(managedHeadersLine);
      status = "updated";
    }
    if (useBearer && !replacedBearer) {
      var bearerIndex = sectionLines.length;
      for (var k = 1; k < sectionLines.length; k++) {
        if (/^\s*startup_timeout_sec\s*=/.test(sectionLines[k])) {
          bearerIndex = k + 1;
          break;
        }
      }
      sectionLines.splice(bearerIndex, 0, bearerLine);
      status = "updated";
    }
    var nextText = lines.slice(0, range.start).concat(sectionLines).concat(lines.slice(range.end)).join("\n").replace(/\n+$/, "\n");
    if (nextText === text.replace(/\n+$/, "\n")) {
      status = "unchanged";
    }
    var withPlaywright = patchCodexPlaywrightMcpConfigText(nextText, options, normalizeDirectory(options.installDir, childPath(resolveWorkspaceRoot(options), "agents/codex"), resolveWorkspaceRoot(options)));
    if (withPlaywright.status !== "unchanged" && status === "unchanged") {
      status = "updated";
    }
    return {
      status: status,
      text: withPlaywright.text
    };
  }

  function writeManagedTextFile(file, content, dryRun) {
    var existed = file.isFile();
    var previous = readTextFile(file);
    var next = String(content == null ? "" : content);
    if (previous === next) {
      return {
        status: "unchanged",
        existed: existed
      };
    }
    if (dryRun !== true) {
      writeTextFile(file, next);
    }
    return {
      status: existed ? "updated" : "created",
      existed: existed
    };
  }

  function convertigoGeneralistReferenceLines() {
    return [
      "- `convertigo://capabilities` - Convertigo MCP capabilities: Core MCP capabilities and recommended authoring flow.",
      "- `convertigo://recipes/quickstart` - Convertigo MCP quickstart recipes: Minimal MCP-first recipes for fast project delivery.",
      "- `convertigo://resources/convertigo-start` - Convertigo Start Guide: Canonical entry guide for tree-first Convertigo MCP work.",
      "- `convertigo://resources/convertigo-crud-fastpath` - Convertigo CRUD Fast Path: Recommended mono-agent path for deterministic SQL CRUD plus starter NGX UI work.",
      "- `convertigo-quickstart` - Convertigo MCP Quickstart: Bootstrap guide selection and route standard SQL CRUD + starter NGX work to the fast path.",
      "- `convertigo-crud-fastpath` - Convertigo CRUD Fast Path: Recommended mono-agent rail for deterministic SQL CRUD plus starter NGX UI work."
    ];
  }

  function buildConvertigoGeneralistSkill(mcpEndpoint) {
    return [
      "---",
      "name: convertigo-generalist",
      "description: Bootstrap Codex for general Convertigo work. Use it to discover Convertigo MCP guides first, choose between exploratory work and the CRUD fast path, and apply the correct naming and viewer rules.",
      "---",
      "",
      "# Convertigo Generalist",
      "",
      "Use this skill for general Convertigo work. Keep it procedural and rely on the MCP guides for the detailed knowledge.",
      "",
      "## Skill freshness",
      "",
      "- Skill guidance version: `" + MCP_GUIDANCE_VERSION + "`.",
      "- During bootstrap, compare this value with `MCP guidance version` in `convertigo://capabilities`. If the MCP value differs or is missing, treat the installed skill and MCP endpoint as out of sync; rerun the Studio Codex setup for the current MCP endpoint or ask before project mutation.",
      "- When the caller surface supports MCP request metadata, send `params._meta.convertigoGuidanceVersion` with this skill guidance version on the first guarded Convertigo `tools/call`; raw HTTP clients may use the `X-Convertigo-Guidance-Version` header. An `_meta.convertigoGuidanceWarning` mismatch requires setup refresh before project mutation. A missing-version warning is advisory when this skill version already matches `convertigo://capabilities`: continue the current task and let the managed host refresh its transport configuration.",
      "",
      "## Mandatory bootstrap",
      "",
      "Bootstrap is required once per agent conversation for a given MCP endpoint and guidance version, not once per user message. On follow-up turns, reuse the skill, capabilities, and route guides already present in the conversation context. Do not reopen this `SKILL.md`, reread `convertigo://capabilities`, or reread an already-used guide unless the MCP endpoint changed, the MCP reports a guidance-version mismatch, or the required bootstrap context is explicitly unavailable.",
      "",
      "1. Read `convertigo://capabilities` directly and verify the skill freshness rule above.",
      "2. Do not call `resources/list`, `resources/templates/list`, or `prompts/list` when this skill already names the required URI or tool. Use catalog discovery only when the task cannot be routed from this skill, a named resource is missing, or the MCP reports a guidance mismatch.",
      "3. Select the smallest matching route and read only its entry recipe before mutation:",
      "   - Standard SQL CRUD + starter NGX UI: read `convertigo://resources/convertigo-crud-fastpath` and use `convertigo-crud-fastpath`.",
      "   - Existing deterministic CRUD project edits: also read `convertigo://resources/convertigo-crud-edit-fastpath`, then stay on the CRUD rail without replaying the new-project bootstrap.",
      "   - New starter NGX app outside the CRUD rail: read `convertigo://resources/convertigo-recipe-starter-extension` before import, then if the app has backend or open-data results, read `convertigo://resources/convertigo-recipe-ngx-data-page` before any page mutation.",
      "   - NGX / Ionic UI creation or edits outside the CRUD rail: read `convertigo://resources/convertigo-recipe-ngx-data-page` for data-backed pages. Read `convertigo://resources/convertigo-frontend-ngx` only when the recipe and live palette contract leave an implementation question.",
      "   - Other tasks: read `convertigo://resources/convertigo-start`, then the smallest matching recipe. Read `convertigo://recipes/quickstart` only when route selection remains ambiguous.",
      "4. Do not call `rag-query` before the chosen recipe was tried.",
      "5. If the user explicitly wants MCP-only work or the starting workspace is empty/non-relevant, do not inspect the local shell workspace before the MCP route decision is made.",
      "",
      "## Tool economy and convergence",
      "",
      "- Treat every tool round trip and large response as part of the task cost. Prefer targeted reads and request only the depth, properties, logs, or detail needed for the next decision.",
      "- Do not repeat catalog, guide, palette, tree, builder, or browser reads whose answer is already present in the current conversation.",
      "- Do not use shell, PowerShell, `rg`, or filesystem scans to rediscover MCP tool signatures or examples already exposed by callable schemas and named recipes. Never recursively search a drive root, user profile, workspace root, or generated frontend tree for browser/build diagnostics; use `mobile-builder-open`, `log-view`, and the managed Playwright page.",
      "- Use `palette-list` to locate an unfamiliar object type and `palette-describe` only for properties that remain uncertain. Group independent descriptions when the caller can do so safely.",
      "- Build one coherent mutation plan before the first write. Prefer one optimized `batch-call` for independent or ordered source-object changes, followed by one targeted readback.",
      "- A class/property shape already used successfully in the current conversation or returned by a targeted tree read is a confirmed contract. Do not reconfirm it through palette calls or tool-metadata inspection.",
      "- Common NGX contracts that do not require palette discovery are `UIStyle#UIStyle.styleContent`, `UIAttribute#UIAttribute.attrName/attrValue`, `UIDynamicElement#TextItem`, `UIText#UIText.textValue`, `UIPageEvent#UIPageEvent.viewEvent`, and `UICustomAction#UICustomAction.actionValue`.",
      "- For one intent spanning independent targets, call `batch-call` with `{calls:[{tool:\"databaseobject-tree-apply\",arguments:{...}}],onError:\"stop\",optimizeMutations:true}`. The optimized batch performs one final refresh, save, and mobile-builder notification.",
      "- Named core tools in this skill are already routed. Do not inspect `ALL_TOOLS` merely to rediscover `batch-call`, `mobile-builder-open`, `log-view`, or Playwright calls.",
      "- For `databaseobject-tree-get`, use `childrenDepth` for recursive descendants and request the needed subtree once instead of walking one QName level per call. `depth` is accepted only as a compatibility alias.",
      "- `databaseobject-tree-apply` always takes the target QName in `target`, never in `qname`. With `at:\"inside\"`, `tree` is the one child being created and must include its own `className` and `name`; never submit a children-only wrapper. Put sibling creations in separate optimized `batch-call` entries.",
      "- For an unfamiliar NGX object, call `palette-list` with the exact intended parent QName as `target`, then pass its returned logical `className` unchanged to `palette-describe`. Do not list at project scope and guess a `#logicalId`.",
      "- Start the viewer asynchronously once UI work is known. Finish the source mutations while it builds, then perform one readiness check and one acceptance-oriented browser proof. Add another cycle only when the proof identifies a concrete defect.",
      "- For a new standard NGX app, the canonical import call is `marketplace-import({project:\"template_ngxBuilderIonic\", importedProjectName:\"<targetProject>\"})`. Call `mobile-builder-open({project:\"<targetProject>\", wait:false})` immediately after import; do not probe `stateOnly:true` before launching.",
      "- If that first viewer launch reports a Node download, npm install, or cold Angular build, finish useful mutations and make one readiness call with `stateOnly:true, wait:true, timeoutSec:180` instead of repeating 30-second polls.",
      "- A browser proof should evaluate all relevant acceptance criteria together when practical: visible content, layout/style, interaction or timed state, and console/runtime errors.",
      "- Stop after the requested behavior is green. Do not add an unsolicited polish pass or repeat proof that cannot change the conclusion.",
      "",
      "## NGX authoring invariants",
      "",
      "- Use the exact SmartType shape reported by the live palette or a successful readback. Do not invent aliases such as `JS`, `SCRIPT`, `PLAIN`, `expression`, or `value` interchangeably.",
      "- Before changing a page `scriptContent`, read it with `properties:\"all\"`, preserve the complete existing string and every `Begin_c8o_...` / `End_c8o_...` section, and edit only the intended section. `mode:\"merge\"` replaces the whole string property; it does not merge script sections.",
      "- Every non-empty NGX `identifier` becomes an Angular/TypeScript reference and must match `[A-Za-z_$][A-Za-z0-9_$]*`, for example `clockDisplay`, never `clock-display`.",
      "- Do not declare framework lifecycle methods such as `ngOnDestroy` in page `scriptContent` unless the live Convertigo contract explicitly provides that extension point. Use a supported page event for cleanup instead of guessing a generated method name.",
      "- For page state changed outside an Angular/Ionic event, such as timers, external callbacks, or third-party subscriptions, mutate the state and trigger Angular change detection through the supported page context in the same callback before claiming live updates.",
      "- Scope page CSS to the element that actually paints the visible area. Do not assume a class or CSS variable crosses an Ionic shadow boundary; include background coverage in the first browser proof.",
      "- When a mutation result reports skipped or normalized properties, repair them before browser proof instead of relying on runtime trial and error.",
      "",
      "## CRUD routing",
      "",
      "- Do not ask the user to choose `upsert-crud`.",
      "- Decide it yourself: use the CRUD rail only when the task is a standard SQL CRUD + starter NGX UI fit.",
      "- Generic CRUD UI default: `ui.variant=entity-pages`.",
      "- CRM-specific UI default: `ui.variant=master-detail`.",
      "- For a new UI project, validate the name, run `marketplace-import` with that exact name, open the viewer immediately with `mobile-builder-open(wait=false)`, then continue with `upsert-crud` and the staged UI kit while the builder warms up.",
      "- For an existing deterministic CRUD project that is already green, use the edit rail: `crud-status` -> optional early `mobile-builder-open(wait=false)` when UI work is likely -> `upsert-crud` -> backend `crud-proof` -> one `upsert-ngx-crud-kit stage=final` -> `mobile-builder-open(stateOnly=true, wait=true)` -> final `crud-proof(viewerUrl)` -> optional `project-save`.",
      "- For a low-detail CRUD prompt, stop after the first green scaffold + demo data: starter import, viewer open, `upsert-crud`, backend proof, `upsert-ngx-crud-kit` bootstrap/final, final UI proof, optional `project-save`, then return.",
      "- The low-detail stop rule applies only when the user requested generic CRUD. Before mutation, list the explicit acceptance behaviors from the request. Filters, counters, domain actions, dashboards, or other named interactions are not proven by the presence of fields or a generic list/detail/form shell; implement and validate each one before claiming completion.",
      "- If the CRUD kit has no declarative hint for an explicit interaction, treat the generated kit as a starting point and perform one focused source-object extension before the final builder and browser proof.",
      "- When relations are obvious, declare them explicitly in `spec.relations[]` instead of relying only on flat FK fields. Prefer entity UI hints such as `ui.relationFields` over direct edits on generated CRUD-kit components.",
      "- Prefer `seed.data` for explicit business demo rows. Do not patch `init_schema` manually after generation when `seed.data` can express the dataset in the spec.",
      "- Once the CRUD guides already documented the contract, do not grep the local workspace to rediscover the shapes of `relations[]`, `ui.relationFields`, or `seed.data`.",
      "- Generated CRUD facade sequences are hidden requestables that require an authenticated context. The generated UI now initializes that session once through a `Login` page that calls `auth_login(username,password)` and then redirects to the visible home page; the business pages should only bootstrap the CRUD data they need.",
      "- Do not start a second refinement pass on screens, layout, labels, or field-level UX unless the user explicitly asked for it.",
      "- Once the CRUD fast path is chosen, do not call `rag-query` unless the built-in guides and CRUD tools are no longer sufficient.",
      "- Prefer best-case-first generated code. Trust the standard error bubble for normal failures instead of adding defensive wrappers by default.",
      "",
      "## Project naming",
      "",
      "- Use exactly the project name requested by the user when it is technically valid.",
      "- If no project is selected and the user explicitly asks to create a new project or application without giving a technical name, derive one concise valid name from the requested product or function, check `project-list` for collisions, then proceed without asking the user to select a project.",
      "- Do not invent prefixes, suffixes, or dates.",
      "- If the requested name collides with an existing project, surface the collision explicitly instead of renaming it.",
      "",
      "## Viewer rule",
      "",
      "- In dev, `mobile-builder-open` serves the live app from the viewer root. Prefer `viewerHomeUrl`, or fall back to `viewerBaseUrl`.",
      "- For frontend work, call `mobile-builder-open` with `wait=false` as soon as the UI project is known, continue other work while it starts, then call `mobile-builder-open(stateOnly=true, wait=true)` or a normal waited call before browser smoke or final proof.",
      "- Do not issue a state-only call before the first asynchronous launch. If the launch reports a cold Node/npm/Angular build, use one waited state call with `timeoutSec:180` after useful mutations instead of repeated 30-second polls.",
      "- If `mobile-builder-open` returns `browserDebugUrl`, `browserDevToolsJsonUrl`, or `browserDevToolsWebSocketUrl`, attach the Playwright MCP browser tools to that visible Studio JxBrowser endpoint and verify the actual feature there.",
      "- If a state-only call returns `status:\"stopped\"`, do not poll it again: immediately call `mobile-builder-open(stateOnly=false, wait=false)` once, continue other work while it starts, then poll readiness.",
      "- Use Playwright MCP only after `mobile-builder-open` reports both `browserDebugPortMatched:true` and `browserControlReady:true`.",
      "- Studio JxBrowser exposes one existing visible page over CDP, not a normal multi-tab browser. Do not create, open, close, select, or navigate tabs/pages; reuse the current page.",
      "- In managed Codex sessions, browser automation is exposed through the Playwright MCP server configured in `codex-home/config.toml`. Use the MCP browser tools; do not run ad hoc shell scripts with `require('playwright')` or raw WebSocket CDP snippets.",
      "- Known-good fast check on this JxBrowser target: `playwright.browser_tabs({action:\"list\"})`, then `playwright.browser_find({text:\"<visible text>\"})`; use `playwright.browser_evaluate({function:\"...\"})` only when DOM state or timing must be measured. Do not probe unsupported browser features before this minimal check.",
      "- An `about:blank` target means the loader is not ready. If the builder status is `building`, poll `mobile-builder-open(stateOnly=true, wait=true)`; if it is `stopped`, launch it asynchronously as described above.",
      "- If Playwright/browser-control MCP tools are missing, disabled, on `about:blank`, stale, or not attached to the returned Studio JxBrowser endpoint, stop the browser proof and tell the user that the managed Playwright MCP configuration must be refreshed. Do not work around it with Node scripts, raw CDP, or a new browser.",
      "- Do not open `DisplayObjects/mobile/...` against the live HMR viewer.",
      "- In prod, the application URL is `.../DisplayObjects/mobile/home`.",
      "- If `mobile-builder-open` reports `compile_error`, treat that as a generator or source-object issue. Do not patch generated runtime sources.",
      "- If builder diagnostics are insufficient, make one focused `log-view({project:\"<targetProject>\",level:\"error\",limit:40,timeoutMs:0})` call. Do not issue separate error and warning scans.",
      "",
      "## Optional UI reveal mode",
      "",
      "- If the integrated assistant or host context says Convertigo reveal mode is enabled, pass `reveal:true` only on supported mutation/viewer tools that should visibly move Studio while you work: `databaseobject-tree-apply`, `mobile-builder-open`, `nocode-form-create`, `nocode-form-edit`, and `nocode-form-update`.",
      "- Do not add `reveal:true` to every read-only call. Use it for object creation/patches, mobile builder opening/polling when focusing the builder is useful, and no-code form mutations that should switch the visible No Code editor.",
      "- For `mobile-builder-open`, use `wait:false` for reveal/focus polls; reserve long `wait:true` calls for readiness proof and omit `reveal` unless the user specifically needs UI focus.",
      "- Treat a `result.reveal.status` of `skipped`, `unsupported`, or `intent` as a UI hint result, not as a project mutation failure.",
      "",
      "## MCP-only boundary",
      "",
      "- Convertigo project descriptors are MCP-owned. Never read or edit `c8oProject.yaml`, `_c8oProject/**/*.yaml`, or `project.xml` as an authoring fallback. If a required MCP operation still fails after one targeted retry, stop and report the blocker without mutating project files.",
      "- Never edit or repair `_private/ionic`, `DisplayObjects`, `dist`, or other generated artifacts.",
      "- Generated artifacts are diagnostic-only surfaces. Fix the Convertigo source objects or the MCP generator instead.",
      "- Do not run `npm run build` or other manual frontend builds outside MCP to close a task.",
      "",
      "## Seed and visible data",
      "",
      "- Prefer realistic seed data by default.",
      "- Prefer semantic preview fields such as `name`, `title`, `city`, `email`, or `comment` over `id` when a visible choice exists.",
      "",
      "## Current public references",
      ""
    ].concat(convertigoGeneralistReferenceLines()).concat([
      "",
      "## Local MCP endpoint",
      "",
      "- Expected local MCP entry: `" + trim(mcpEndpoint) + "`",
      "- If Codex is not yet configured for Convertigo, run the local Studio sequence `_setupCodex` from the lib_ConvertigoMCP project.",
      ""
    ]).join("\n");
  }

  function buildConvertigoNoCodeSkill(mcpEndpoint) {
    return [
      "---",
      "name: convertigo-nocode",
      "description: Work with Convertigo No-Code Studio / C8Oforms through Convertigo MCP. Use for forms, no-code apps, pages, fields, data sources, roles, publication, and C8Oforms administration.",
      "---",
      "",
      "# Convertigo NoCode",
      "",
      "Use this skill when the Assistant is embedded in C8Oforms or any Convertigo No-Code Studio surface.",
      "",
      "## Skill freshness",
      "",
      "- Skill guidance version: `" + MCP_GUIDANCE_VERSION + "`.",
      "- During bootstrap, compare this value with `MCP guidance version` in `convertigo://capabilities`. If the MCP value differs or is missing, rerun the Studio Codex setup for the current MCP endpoint before using no-code mutation tools.",
      "- When the caller surface supports MCP request metadata, send `params._meta.convertigoGuidanceVersion` with this skill guidance version on the first guarded Convertigo `tools/call`; raw HTTP clients may use the `X-Convertigo-Guidance-Version` header. An `_meta.convertigoGuidanceWarning` mismatch requires setup refresh before no-code mutation. A missing-version warning is advisory when this skill version already matches `convertigo://capabilities`: continue the current task and let the managed host refresh its transport configuration.",
      "",
      "## Mandatory workflow",
      "",
      "1. Read `convertigo://capabilities` directly to verify guidance freshness. Skip catalog and prompt lists when this skill already names the required no-code tools.",
      "2. Treat the selected no-code context as the source of truth. In C8Oforms, target the `C8Oforms` project unless the user explicitly names another no-code project.",
      "3. Use Convertigo MCP tools to inspect, edit, save, reload, and validate. Do not edit generated folders such as `_private/ionic`, `DisplayObjects`, `dist`, or build outputs.",
      "4. Prefer one contract read, one coherent mutation, and one compile/validation pass. Repeat only to repair a concrete failed criterion.",
      "5. Keep explanations no-code oriented: applications, forms, pages, fields, data sources, roles, permissions, publication, and user-facing behavior.",
      "6. Reply to the user in their language. Keep progress updates short, factual, and user-safe.",
      "",
      "## Convertigo MCP entry",
      "",
      "- Expected MCP endpoint: `" + trim(mcpEndpoint) + "`",
      "- Prefer MCP tools over filesystem edits for Convertigo objects.",
      "- Use the synchronized MCP knowledge pack in `skills/convertigo-mcp/` only for additional tool/resource details.",
      "",
      "## Optional UI reveal mode",
      "",
      "- If the integrated assistant or host context says Convertigo reveal mode is enabled, pass `reveal:true` only on supported no-code mutation tools that should visibly move No Code Studio while you work: `nocode-form-create`, `nocode-form-edit`, and `nocode-form-update`.",
      "- Do not add `reveal:true` to read-only calls such as contract, compile, validate, catalog, or log tools.",
      "- Treat a `result.reveal.status` of `skipped`, `unsupported`, or `intent` as a UI hint result, not as a no-code mutation failure.",
      "",
      "## Tool discovery fallback",
      "",
      "- The NoCode tools can appear as `nocode-form-contract-get`, `nocode-form-edit`, `nocode-form-update`, `nocode-form-validate`, and `nocode-form-compile`.",
      "- Some providers expose tool names with underscores, such as `nocode_form_contract_get` or `mcp__convertigo.nocode_form_update`; treat these as the same NoCode tools.",
      "- If `tool_search` returns no NoCode tools on the first try, retry with exact queries for `Convertigo NoCode form contract get edit update validate compile C8Oforms` and `nocode-form-contract-get nocode-form-edit nocode-form-update` before declaring the tools unavailable.",
      "- If a current NoCode form id or URL is provided by the host application, use it as the default target for form edits unless the user explicitly names another form."
    ].join("\n");
  }

  function buildConvertigoStudioRouterSkill(legacyOnly) {
    if (legacyOnly === true || !flowCapabilityAvailable()) {
      return [
        "---",
        "name: convertigo-studio",
        "description: Route Convertigo Studio tasks to the standard Convertigo capability pack. Use this skill first for project creation, inspection, mutation, validation, backend work, frontend work, or viewer work.",
        "---",
        "",
        "# Convertigo Studio router",
        "",
        "This is a Low Code Studio session. The `convertigo` MCP server is installed in this agent home.",
        "The No Code capability is unavailable to the Studio user and must never be used from this session.",
        "",
        "## Mandatory workflow",
        "",
        "1. Read `skills/convertigo-generalist/SKILL.md` before the first authoring operation.",
        "2. Use the `convertigo` MCP server for project inspection, mutation, synchronization, and validation.",
        "3. Never edit Convertigo YAML or generated files as a fallback.",
        "4. Reply in the user's language."
      ].join("\n");
    }
    return [
      "---",
      "name: convertigo-studio",
      "description: Route every Convertigo Studio task to the Legacy or Flow capability pack. Use this skill first for Convertigo project creation, inspection, mutation, validation, backend work, frontend work, or viewer work.",
      "---",
      "",
      "# Convertigo Studio router",
      "",
      "This is a Low Code Studio session. Both the `convertigo` and `convertigo-flow` MCP servers are installed in the same Codex home.",
      "The No Code capability is unavailable to the Studio user and must never be used from this session.",
      "",
      "## Route once before authoring",
      "",
      "1. An explicit user request for Flow, FlowScript, or Flow Svelte wins: read `skills/convertigo-flow-mcp/SKILL.md`, then the backend or frontend specialist skill needed by the task, and use `convertigo-flow`.",
      "2. An explicit user request for legacy Convertigo or NGX wins: read `skills/convertigo-generalist/SKILL.md` and use `convertigo`.",
      "3. For an existing project, a FlowEngine or Flow frontend selects Flow; legacy Sequences, Connectors, Application, or NGX objects select Legacy for the corresponding work.",
      "4. A mixed project may require both routes, but each mutation must use the MCP that owns the target model. Never edit Convertigo YAML or generated files to cross the boundary.",
      "5. If a new-project request is genuinely ambiguous, prefer the technology named by the user. Ask one short question only when the choice changes the requested product behavior.",
      "",
      "## Working rules",
      "",
      "- Treat the conversation profile as a routing hint, not as a tool-access boundary.",
      "- Keep one conversation and one history when switching between Legacy and Flow.",
      "- Do not fall back from one MCP to the other after a tool error. Fix the owning capability or report the configuration defect.",
      "- Use the selected capability pack's guides and validation workflow before claiming completion.",
      "- Reply in the user's language."
    ].join("\n");
  }

  function installStudioRouterSkill(homePath, dryRun, legacyOnly) {
    var codexHome = new File(effectiveCodexHomePath(homePath));
    var skillFile = new File(new File(new File(codexHome, "skills"), STUDIO_ROUTER_SKILL_SLUG), "SKILL.md");
    var write = writeManagedTextFile(skillFile, buildConvertigoStudioRouterSkill(legacyOnly === true), dryRun === true);
    return {
      status: write.status,
      path: filePath(skillFile)
    };
  }

  function removeStudioNoCodeSkill(homePath, dryRun) {
    var codexHome = new File(effectiveCodexHomePath(homePath));
    var skillDir = new File(new File(codexHome, "skills"), "convertigo-nocode");
    var result = {
      status: "absent",
      path: filePath(skillDir),
      errors: []
    };
    if (!skillDir.exists()) {
      return result;
    }
    if (dryRun === true) {
      result.status = "would-remove";
      return result;
    }
    var removed = [];
    result.status = deleteDirectoryTree(skillDir, removed, result.errors) ? "removed" : "error";
    return result;
  }

  function removeUnavailableStudioCapabilities(homePath, dryRun) {
    var codexHome = new File(effectiveCodexHomePath(homePath));
    var result = { status: "unchanged", errors: [] };
    var slugs = ["convertigo-flow-mcp", "convertigo-flow-backend", "convertigo-flow-frontend-svelte"];
    var changed = false;
    for (var i = 0; i < slugs.length; i++) {
      var skillDir = new File(new File(codexHome, "skills"), slugs[i]);
      if (!skillDir.exists()) {
        continue;
      }
      changed = true;
      if (dryRun !== true) {
        deleteDirectoryTree(skillDir, [], result.errors);
      }
    }
    var configFile = new File(codexHome, "config.toml");
    if (configFile.isFile()) {
      var original = readTextFile(configFile).replace(/\r\n?/g, "\n");
      var lines = splitTextLines(original);
      var sections = [
        "mcp_servers.convertigo-flow.env_http_headers",
        "mcp_servers.convertigo-flow.http_headers",
        "mcp_servers.convertigo-flow"
      ];
      for (var sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
        var removed = removeTomlSection(lines, sections[sectionIndex]);
        lines = removed.lines;
        changed = changed || removed.removed;
      }
      var next = lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "\n");
      if (next !== original.replace(/\n+$/, "\n") && dryRun !== true) {
        writeTextFile(configFile, next);
      }
    }
    result.status = changed ? (dryRun === true ? "would-update" : (result.errors.length ? "error" : "updated")) : "unchanged";
    return result;
  }

  function mcpSessionCookieFromConfig(configText, serverName) {
    var lines = String(configText == null ? "" : configText).replace(/\r\n?/g, "\n").split("\n");
    var nestedRange = findTomlSectionRange(lines, "mcp_servers." + trim(serverName) + ".http_headers");
    if (nestedRange.found) {
      for (var nestedIndex = nestedRange.start + 1; nestedIndex < nestedRange.end; nestedIndex++) {
        var nestedMatch = /^\s*["']?Cookie["']?\s*=\s*["'](JSESSIONID=[A-Za-z0-9._-]+)["']/.exec(lines[nestedIndex]);
        if (nestedMatch !== null) {
          return trim(nestedMatch[1]);
        }
      }
    }
    var range = findTomlSectionRange(lines, "mcp_servers." + trim(serverName));
    if (!range.found) {
      return "";
    }
    for (var i = range.start + 1; i < range.end; i++) {
      if (!/^\s*http_headers\s*=/.test(lines[i])) {
        continue;
      }
      var match = /["']Cookie["']\s*=\s*["'](JSESSIONID=[A-Za-z0-9._-]+)["']/.exec(lines[i]);
      return match === null ? "" : trim(match[1]);
    }
    return "";
  }

  function responseSessionCookie(header) {
    var match = /(?:^|[,;]\s*)(JSESSIONID=[A-Za-z0-9._-]+)/i.exec(trim(header));
    return match === null ? "" : match[1];
  }

  function refreshMcpSessionCookie(mcpEndpoint, existingCookie) {
    var endpoint = managedMcpTransportEndpoint(mcpEndpoint);
    var connection = null;
    var stream = null;
    try {
      var url = new URL(endpoint);
      var host = trim(url.getHost()).toLowerCase();
      if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
        return trim(existingCookie);
      }
      connection = url.openConnection();
      connection.setConnectTimeout(5000);
      connection.setReadTimeout(5000);
      connection.setRequestMethod("GET");
      connection.setRequestProperty("Accept", "application/json");
      connection.setRequestProperty(
        "Cookie",
        trim(existingCookie).length
          ? trim(existingCookie)
          : "JSESSIONID=managed-mcp-bootstrap-" + String(UUID.randomUUID()).replace(/-/g, "")
      );
      var code = connection.getResponseCode();
      var refreshed = responseSessionCookie(connection.getHeaderField("Set-Cookie"));
      stream = code >= 400 ? connection.getErrorStream() : connection.getInputStream();
      if (stream !== null) {
        while (stream.read() !== -1) {}
      }
      return refreshed.length ? refreshed : trim(existingCookie);
    } catch (_ignoreMcpSessionRefresh) {
      try {
        log.warn("Unable to refresh managed MCP HTTP session for " + endpoint + ": " + String(_ignoreMcpSessionRefresh));
      } catch (_ignoreMcpSessionRefreshLog) {}
      return trim(existingCookie);
    } finally {
      try { if (stream !== null) stream.close(); } catch (_ignoreMcpStreamClose) {}
      try { if (connection !== null) connection.disconnect(); } catch (_ignoreMcpDisconnect) {}
    }
  }

  function withManagedMcpSession(options, existingConfig, mcpEndpoint) {
    var next = {};
    options = options || {};
    for (var key in options) {
      if (Object.prototype.hasOwnProperty.call(options, key)) {
        next[key] = options[key];
      }
    }
    if (!boolValue(options.dryRun, false)) {
      var serverName = managedMcpServerName(options);
      next.mcpSessionCookie = refreshMcpSessionCookie(
        mcpEndpoint,
        mcpSessionCookieFromConfig(existingConfig, serverName)
      );
    }
    return next;
  }

  function setupCodexGeneralist(options, homePath, mcpEndpoint) {
    var capabilityProfile = agentCapabilityProfile(options);
    var profile = capabilityProfile.id;
    var skillSlug = capabilityProfile.skillSlug;
    var skillLabel = capabilityProfile.label;
    var report = {
      attempted: false,
      ok: true,
      provider: "codex",
      source: skillLabel + " setup",
      target: "",
      skillStatus: "skipped",
      backendSkillStatus: "skipped",
      frontendSkillStatus: "skipped",
      configStatus: "skipped",
      resolvedCodexHome: "",
      resolvedMcpUrl: trim(mcpEndpoint) || resolveMcpEndpoint(options),
      skillPath: "",
      backendSkillPath: "",
      frontendSkillPath: "",
      warnings: [],
      nextSteps: [
        "Restart Codex to pick up the updated skill list.",
        "Start a fresh Codex session in the Convertigo workspace.",
        "Use the generated " + skillSlug + " skill for this Convertigo surface."
      ],
      dryRun: boolValue(options.dryRun, false),
      skipped: false,
      message: "",
      error: "",
      generated: [],
      reused: [],
      copied: []
    };
    if (boolValue(options.skipSkillsInstall || options.skipSkillSync, false)) {
      report.skipped = true;
      report.message = skillLabel + " setup disabled by request";
      return report;
    }
    report.attempted = true;
    try {
      var codexHome = new File(effectiveCodexHomePath(homePath));
      var skillFile = new File(new File(new File(codexHome, "skills"), skillSlug), "SKILL.md");
      var configFile = new File(codexHome, "config.toml");
      var skipDelegatedSetup = boolValue(options.skipMcpProjectSkillSync || options.skipSetupCodexDelegate, false);
      if (skipDelegatedSetup && capabilityProfile.setupRequired) {
        report.ok = false;
        report.error = "The " + capabilityProfile.setupProject + " setup cannot be skipped for the " + profile + " profile";
        report.message = "Required capability setup was disabled by request";
        return report;
      }
      if (!skipDelegatedSetup) {
        var delegated = setupCodexFromMcpProject(options, codexHome, report.resolvedMcpUrl, profile);
        if (delegated.attempted === true && delegated.ok === true) {
          var delegatedConfig = readTextFile(configFile);
          var delegatedOptions = withManagedMcpSession(options, delegatedConfig, delegated.resolvedMcpUrl);
          var delegatedPatch = patchCodexMcpConfigText(delegatedConfig, delegated.resolvedMcpUrl, delegatedOptions, codexHome);
          if (delegatedPatch.status !== "unchanged" && report.dryRun !== true) {
            writeTextFile(configFile, delegatedPatch.text);
          }
          report.skillStatus = delegated.skillStatus;
          report.backendSkillStatus = delegated.backendSkillStatus || report.backendSkillStatus;
          report.frontendSkillStatus = delegated.frontendSkillStatus || report.frontendSkillStatus;
          report.configStatus = delegatedPatch.status !== "unchanged" ? delegatedPatch.status : delegated.configStatus;
          report.resolvedCodexHome = delegated.resolvedCodexHome || filePath(codexHome);
          report.resolvedMcpUrl = delegated.resolvedMcpUrl || report.resolvedMcpUrl;
          report.target = report.resolvedCodexHome;
          report.skillPath = delegated.skillPath || filePath(skillFile);
          report.backendSkillPath = delegated.backendSkillPath || "";
          report.frontendSkillPath = delegated.frontendSkillPath || "";
          report.source = delegated.source;
          report.warnings = report.warnings.concat(delegated.warnings || []);
          if (report.skillStatus === "unchanged") {
            report.reused.push("skills/" + skillSlug + "/SKILL.md");
          } else {
            report.generated.push("skills/" + skillSlug + "/SKILL.md");
          }
          if (profile === "flow") {
            if (report.backendSkillStatus === "unchanged") {
              report.reused.push("skills/convertigo-flow-backend/SKILL.md");
            } else {
              report.generated.push("skills/convertigo-flow-backend/SKILL.md");
            }
            if (report.frontendSkillStatus === "unchanged") {
              report.reused.push("skills/convertigo-flow-frontend-svelte/SKILL.md");
            } else {
              report.generated.push("skills/convertigo-flow-frontend-svelte/SKILL.md");
            }
          }
          if (report.configStatus === "unchanged") {
            report.reused.push("config.toml");
          } else {
            report.generated.push("config.toml");
          }
          report.message = delegated.message;
          if (profile === "nocode" && report.dryRun !== true) {
            writeManagedTextFile(new File(codexHome, "AGENTS.md"), agentSkillInstructions("codex", profile), false);
          }
          return report;
        }
        if (delegated.attempted === true && delegated.message) {
          report.warnings.push(delegated.message + (delegated.error ? ": " + delegated.error : ""));
        }
        if (capabilityProfile.setupRequired) {
          report.ok = false;
          report.error = delegated.error || delegated.message || "Required capability setup failed";
          report.message = "Unable to configure required " + skillLabel + " capability pack";
          return report;
        }
      }
      var skillSource = managedSkillContent(options, profile, report.resolvedMcpUrl);
      if (skillSource.missing === true || !trim(skillSource.content).length) {
        throw new Error("Managed skill source not found for " + skillSlug);
      }
      var skillWrite = writeManagedTextFile(skillFile, skillSource.content, report.dryRun);
      if (capabilityProfile.specialistSkillSlugs.length) {
        var specialistSlugs = capabilityProfile.specialistSkillSlugs;
        for (var specialistIndex = 0; specialistIndex < specialistSlugs.length; specialistIndex++) {
          var specialistSlug = specialistSlugs[specialistIndex];
          var specialistSource = flowSkillSourceFile(options, specialistSlug);
          if (specialistSource === null) {
            throw new Error("Missing managed specialist skill: " + specialistSlug);
          }
          var specialistFile = new File(new File(new File(codexHome, "skills"), specialistSlug), "SKILL.md");
          var specialistWrite = writeManagedTextFile(specialistFile, readTextFile(specialistSource), report.dryRun);
          if (specialistSlug === "convertigo-flow-backend") {
            report.backendSkillStatus = specialistWrite.status;
            report.backendSkillPath = filePath(specialistFile);
          } else {
            report.frontendSkillStatus = specialistWrite.status;
            report.frontendSkillPath = filePath(specialistFile);
          }
          if (specialistWrite.status === "unchanged") {
            report.reused.push("skills/" + specialistSlug + "/SKILL.md");
          } else {
            report.copied.push("skills/" + specialistSlug + "/SKILL.md");
          }
        }
      }
      var existingConfig = readTextFile(configFile);
      var managedOptions = withManagedMcpSession(options, existingConfig, report.resolvedMcpUrl);
      var patchedConfig = patchCodexMcpConfigText(existingConfig, report.resolvedMcpUrl, managedOptions, codexHome);
      if (patchedConfig.status !== "unchanged" && report.dryRun !== true) {
        writeTextFile(configFile, patchedConfig.text);
      }
      report.skillStatus = skillWrite.status;
      report.configStatus = patchedConfig.status;
      report.resolvedCodexHome = filePath(codexHome);
      report.target = report.resolvedCodexHome;
      report.skillPath = filePath(skillFile);
      report.source = skillSource.source || report.source;
      if (skillWrite.status === "unchanged") {
        report.reused.push("skills/" + skillSlug + "/SKILL.md");
      } else if (skillSource.copied === true) {
        report.copied.push("skills/" + skillSlug + "/SKILL.md");
      } else {
        report.generated.push("skills/" + skillSlug + "/SKILL.md");
      }
      if (patchedConfig.status === "unchanged") {
        report.reused.push("config.toml");
      } else {
        report.generated.push("config.toml");
      }
      report.message = skillLabel + " skill configured";
      if (profile === "nocode" && report.dryRun !== true) {
        writeManagedTextFile(new File(codexHome, "AGENTS.md"), agentSkillInstructions("codex", profile), false);
      }
    } catch (e) {
      report.ok = false;
      report.error = String(e);
      report.message = "Unable to configure " + skillLabel + " skill";
    }
    return report;
  }

  function setupCodexStudio(options, homePath) {
    var generalistOptions = copyOptionsWithProfile(options, "generalist");
    var generalist = setupCodexGeneralist(generalistOptions, homePath, generalistOptions.mcpEndpoint);
    var flowEnabled = flowCapabilityAvailable();
    var flowOptions = flowEnabled ? copyOptionsWithProfile(options, "flow") : null;
    var flow = flowEnabled ? setupCodexGeneralist(flowOptions, homePath, flowOptions.mcpEndpoint) : null;
    var dryRun = boolValue(options && options.dryRun, false);
    var compatibilityCleanup = flowEnabled
      ? { status: "unchanged", errors: [] }
      : removeUnavailableStudioCapabilities(homePath, dryRun);
    var router = installStudioRouterSkill(homePath, dryRun);
    var noCodeSkill = removeStudioNoCodeSkill(homePath, dryRun);
    var report = {
      attempted: generalist.attempted === true || (flow !== null && flow.attempted === true),
      ok: generalist.ok === true && (flow === null || flow.ok === true),
      provider: "codex",
      source: "Convertigo Studio setup",
      target: generalist.target || (flow !== null ? flow.target : "") || trim(homePath),
      skillStatus: generalist.skillStatus || "skipped",
      configStatus: generalist.configStatus === "unchanged" && (flow === null || flow.configStatus === "unchanged")
        ? "unchanged"
        : "updated",
      routerSkillStatus: router.status,
      noCodeSkillStatus: noCodeSkill.status,
      compatibilityCleanupStatus: compatibilityCleanup.status,
      resolvedCodexHome: generalist.resolvedCodexHome || (flow !== null ? flow.resolvedCodexHome : "") || trim(homePath),
      resolvedMcpUrl: generalist.resolvedMcpUrl || generalistOptions.mcpEndpoint,
      skillPath: generalist.skillPath || "",
      routerSkillPath: router.path,
      warnings: (generalist.warnings || []).concat(flow !== null ? (flow.warnings || []) : []),
      nextSteps: [
        "Restart Codex only when an already running app-server does not reload the unified configuration.",
        "Route each task through the convertigo-studio skill."
      ],
      dryRun: dryRun,
      skipped: generalist.skipped === true && (flow === null || flow.skipped === true),
      message: flowEnabled
        ? "Convertigo Studio configured with Legacy and Flow capabilities"
        : "Convertigo Studio configured",
      error: "",
      generated: (generalist.generated || []).concat(flow !== null ? (flow.generated || []) : []),
      reused: (generalist.reused || []).concat(flow !== null ? (flow.reused || []) : []),
      copied: (generalist.copied || []).concat(flow !== null ? (flow.copied || []) : []),
      profiles: { generalist: generalist }
    };
    if (flow !== null) {
      report.backendSkillStatus = flow.backendSkillStatus || "skipped";
      report.frontendSkillStatus = flow.frontendSkillStatus || "skipped";
      report.resolvedFlowMcpUrl = flow.resolvedMcpUrl || flowOptions.mcpEndpoint;
      report.backendSkillPath = flow.backendSkillPath || "";
      report.frontendSkillPath = flow.frontendSkillPath || "";
      report.profiles.flow = flow;
    }
    if (router.status === "unchanged") {
      report.reused.push("skills/" + STUDIO_ROUTER_SKILL_SLUG + "/SKILL.md");
    } else {
      report.generated.push("skills/" + STUDIO_ROUTER_SKILL_SLUG + "/SKILL.md");
    }
    if (noCodeSkill.status === "removed" || noCodeSkill.status === "would-remove") {
      report.removed = ["skills/convertigo-nocode"];
    }
    if (noCodeSkill.status === "error") {
      report.ok = false;
      report.warnings.push("Unable to remove the NoCode skill from the Studio home: " + JSON.stringify(noCodeSkill.errors));
    }
    if (compatibilityCleanup.status === "error") {
      report.ok = false;
      report.warnings.push("Unable to remove unavailable experimental capability files: " + JSON.stringify(compatibilityCleanup.errors));
    }
    if (!report.ok) {
      report.error = [generalist.error, flow !== null ? flow.error : ""].filter(function (value) { return trim(value).length; }).join("; ");
      report.message = "Unable to configure Convertigo Studio";
    }
    return report;
  }

  function installAgentSkills(options, provider, homePath) {
    options = options || {};
    if (normalizeProvider(provider) === "claude" && typeof installClaudeSkills === "function") {
      return installClaudeSkills(options, homePath);
    }
    if (normalizeProvider(provider) === "codex") {
      var codexReport;
      if (normalizeSkillProfile(options) !== "nocode") {
        codexReport = setupCodexStudio(options, homePath);
      } else {
        codexReport = setupCodexGeneralist(options, homePath, resolveMcpEndpoint(options));
      }
      codexReport.bundle = managedSkillBundleState(options, homePath);
      return codexReport;
    }
    var profile = normalizeSkillProfile(options);
    var report = {
      attempted: false,
      ok: true,
      provider: normalizeProvider(provider),
      source: "",
      target: "",
      copied: [],
      generated: [],
      reused: [],
      skipped: false,
      message: "",
      error: ""
    };
    if (boolValue(options.skipSkillsInstall || options.skipSkillSync, false)) {
      report.skipped = true;
      report.message = "Skill synchronization disabled by request";
      return report;
    }
    if (profile === "flow") {
      report.ok = false;
      report.skipped = true;
      report.message = "The Flow capability pack currently requires the Codex provider";
      return report;
    }
    var home = trim(homePath);
    if (!home.length) {
      report.skipped = true;
      report.message = "Using the default agent home; skill synchronization skipped";
      return report;
    }
    if (profile !== "nocode") {
      return setupVibeFromMcpProject(options, new File(home), resolveMcpEndpoint(options));
    }
    report.attempted = true;
    try {
      var homeDir = new File(home);
      ensureDirectory(homeDir);
      var noCodeSkillFile = new File(new File(new File(homeDir, "skills"), "convertigo-nocode"), "SKILL.md");
      var noCodeSkill = managedSkillContent(options, profile, resolveMcpEndpoint(options));
      var noCodeWrite = writeManagedTextFile(noCodeSkillFile, noCodeSkill.content, false);
      if (noCodeWrite.status === "unchanged") {
        report.reused.push("skills/convertigo-nocode/SKILL.md");
      } else if (noCodeSkill.copied === true) {
        report.copied.push("skills/convertigo-nocode/SKILL.md");
      } else {
        report.generated.push("skills/convertigo-nocode/SKILL.md");
      }
      writeTextFile(new File(homeDir, "AGENTS.md"), agentSkillInstructions(provider, profile));
      report.generated.push("AGENTS.md");
      report.message = "Convertigo NoCode skills synchronized";
    } catch (e) {
      report.ok = false;
      report.error = String(e);
      report.message = "Unable to synchronize Convertigo MCP skills";
    }
    return report;
  }

  function appendCodexConvertigoMcpConfig(configFile, mcpEndpoint, options) {
    var endpoint = trim(mcpEndpoint) || resolveMcpEndpoint(options || {});
    var text = configFile.exists() ? readTextFile(configFile) : "";
    if (!text.length) {
      text = [
        "# Generated by lib_ConvertigoAgentBridge.",
        'preferred_auth_method = "chat"',
        ""
      ].join("\n");
    }
    var patched = patchCodexMcpConfigText(text, endpoint, options || {}, configFile.getParentFile());
    if (patched.status === "unchanged") {
      return false;
    }
    writeTextFile(configFile, patched.text);
    return true;
  }

  function managedMcpServerName(options) {
    return agentCapabilityProfile(options || {}).mcpServerName;
  }

  function copyCodexUserFileIfMissing(sourceDir, targetDir, filename, report) {
    var source = new File(sourceDir, filename);
    if (!source.isFile()) {
      return;
    }
    var target = new File(targetDir, filename);
    if (target.exists()) {
      report.reused.push(filename);
      return;
    }
    writeTextFile(target, readTextFile(source));
    report.copied.push(filename);
  }

  function syncAgentUserFile(sourceDir, targetDir, filename, report, force) {
    var source = new File(sourceDir, filename);
    if (!source.isFile()) {
      return;
    }
    var target = new File(targetDir, filename);
    try {
      if (filePath(source) === filePath(target)) {
        report.reused.push(filename);
        return;
      }
    } catch (_ignoreSameCodexFile) {}
    if (target.exists()) {
      try {
        if (sha256File(source) === sha256File(target)) {
          report.reused.push(filename);
          return;
        }
      } catch (_ignoreCodexHash) {}
      if (force !== true) {
        try {
          if (Number(source.lastModified()) <= Number(target.lastModified())) {
            report.reused.push(filename);
            return;
          }
        } catch (_ignoreCodexTimestamp) {}
      }
      copyFileBinary(source, target);
      if (!report.refreshed) {
        report.refreshed = [];
      }
      report.refreshed.push(filename);
      return;
    }
    copyFileBinary(source, target);
    report.copied.push(filename);
  }

  function newestAgentUserFile(directories, filename) {
    var selected = null;
    for (var i = 0; directories && i < directories.length; i++) {
      var candidate = new File(directories[i], filename);
      if (!candidate.isFile()) {
        continue;
      }
      if (selected === null || Number(candidate.lastModified()) > Number(selected.lastModified())) {
        selected = candidate;
      }
    }
    return selected;
  }

  function syncNewestAgentUserFile(sourceDirs, targetDir, filename, report) {
    var source = newestAgentUserFile(sourceDirs, filename);
    if (source === null) {
      return;
    }
    syncAgentUserFile(source.getParentFile(), targetDir, filename, report);
  }

  function newestUsableCodexAuthFile(directories) {
    var selected = null;
    for (var i = 0; directories && i < directories.length; i++) {
      var candidate = new File(directories[i], "auth.json");
      var state = codexAuthFileState(candidate);
      if (!state.exists || state.expired) {
        continue;
      }
      if (selected === null || Number(candidate.lastModified()) > Number(selected.lastModified())) {
        selected = candidate;
      }
    }
    return selected;
  }

  function syncCodexAuthenticationFile(sourceDirs, targetDir, report) {
    var source = newestUsableCodexAuthFile(sourceDirs);
    if (source === null) {
      syncNewestAgentUserFile(sourceDirs, targetDir, "auth.json", report);
      return;
    }
    var targetState = codexAuthFileState(new File(targetDir, "auth.json"));
    syncAgentUserFile(source.getParentFile(), targetDir, "auth.json", report, targetState.exists && targetState.expired);
    report.authenticationSource = filePath(source.getParentFile());
    report.authenticationImported = !targetState.exists || targetState.expired;
  }

  function codexCredentialSourceDirs(options, homeDir) {
    options = options || {};
    var sources = [];
    var workspaceRoot = resolveWorkspaceRoot(options);
    var installDir = normalizeDirectory(options.installDir, childPath(workspaceRoot, "agents/codex"), workspaceRoot);
    var userHome = resolveCodexHome({
      workspaceRoot: workspaceRoot,
      installDir: installDir,
      codexHomeScope: "user",
      userId: trim(options.userId) || contextUserId()
    }, installDir);
    if (trim(userHome.path).length && filePath(new File(userHome.path)) !== filePath(homeDir)) {
      sources.push(new File(userHome.path));
    }
    sources.push(new File(String(System.getProperty("user.home")), ".codex"));
    return sources;
  }

  function bootstrapCodexHome(options, homePath, mcpEndpoint) {
    var report = {
      attempted: false,
      ok: true,
      home: trim(homePath),
      copied: [],
      reused: [],
      refreshed: [],
      generated: [],
      authenticationSource: "",
      authenticationImported: false,
      message: "",
      error: ""
    };
    if (!report.home.length) {
      report.message = "Default CODEX_HOME selected; bootstrap skipped";
      return report;
    }
    report.attempted = true;
    try {
      var homeDir = new File(report.home);
      migrateLegacyHiddenCodexHome(homeDir, report);
      ensureDirectory(homeDir);
      var credentialSources = codexCredentialSourceDirs(options, homeDir);
      syncCodexAuthenticationFile(credentialSources, homeDir, report);
      syncNewestAgentUserFile(credentialSources, homeDir, "auth.json.api", report);
      syncNewestAgentUserFile(credentialSources, homeDir, "installation_id", report);
      var configFile = new File(homeDir, "config.toml");
      var capabilityProfile = agentCapabilityProfile(options || {});
      if (capabilityProfile.id === "nocode") {
        if (appendCodexConvertigoMcpConfig(configFile, mcpEndpoint, options)) {
          report.generated.push("config.toml");
        } else {
          report.reused.push("config.toml");
        }
        report.message = "Scoped NoCode CODEX_HOME bootstrapped";
      } else {
        var generalistOptions = copyOptionsWithProfile(options, "generalist");
        var generalistChanged = appendCodexConvertigoMcpConfig(configFile, generalistOptions.mcpEndpoint, generalistOptions);
        var flowChanged = false;
        if (flowCapabilityAvailable()) {
          var flowOptions = copyOptionsWithProfile(options, "flow");
          flowChanged = appendCodexConvertigoMcpConfig(configFile, flowOptions.mcpEndpoint, flowOptions);
        }
        if (generalistChanged || flowChanged) {
          report.generated.push("config.toml");
        } else {
          report.reused.push("config.toml");
        }
        report.message = flowCapabilityAvailable()
          ? "Scoped Studio CODEX_HOME bootstrapped with Legacy and Flow MCP servers"
          : "Scoped Studio CODEX_HOME bootstrapped";
      }
    } catch (e) {
      report.ok = false;
      report.error = String(e);
      report.message = "Unable to bootstrap scoped CODEX_HOME";
    }
    return report;
  }

  function vibeCredentialSourceDirs(options, homeDir) {
    options = options || {};
    var sources = [];
    var gateway = isConvertigoGatewayProfile(options);
    try {
      var workspaceRoot = resolveWorkspaceRoot(options);
      var installDir = normalizeDirectory(options.installDir, childPath(workspaceRoot, "agents/vibe"), workspaceRoot);
      var userHome = resolveVibeHome({
        vibeHomeScope: "user",
        vibeProfile: resolveVibeProfile(options),
        userId: trim(options.userId) || contextUserId()
      }, installDir);
      if (trim(userHome.path).length && filePath(new File(userHome.path)) !== filePath(homeDir)) {
        sources.push(new File(userHome.path));
      }
    } catch (_ignoreVibeUserHome) {}
    if (!gateway) {
      sources.push(new File(String(System.getProperty("user.home")), ".vibe"));
    }
    return sources;
  }

  function bootstrapVibeHome(homePath, options) {
    var report = {
      attempted: false,
      ok: true,
      home: trim(homePath),
      copied: [],
      reused: [],
      refreshed: [],
      message: "",
      error: ""
    };
    if (!report.home.length) {
      report.message = "Default VIBE_HOME selected; bootstrap skipped";
      return report;
    }
    report.attempted = true;
    try {
      var homeDir = new File(report.home);
      ensureDirectory(homeDir);
      syncNewestAgentUserFile(vibeCredentialSourceDirs(options, homeDir), homeDir, ".env", report);
      if (isConvertigoGatewayProfile(options)) {
        report.gatewayKey = syncConvertigoGatewayKey(options, homeDir, report).reason;
      }
      report.message = "Scoped VIBE_HOME credentials synchronized";
    } catch (e) {
      report.ok = false;
      report.error = String(e);
      report.message = "Unable to bootstrap scoped VIBE_HOME";
    }
    return report;
  }

  function readEnvFile(file) {
    var result = {
      path: filePath(file),
      exists: file.exists(),
      keys: [],
      values: {}
    };
    if (!result.exists) {
      return result;
    }
    var lines = readTextFile(file).split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = trim(lines[i]);
      if (!line.length || line.indexOf("#") === 0) {
        continue;
      }
      if (line.indexOf("export ") === 0) {
        line = trim(line.substring(7));
      }
      var eq = line.indexOf("=");
      if (eq <= 0) {
        continue;
      }
      var key = trim(line.substring(0, eq));
      var value = trim(line.substring(eq + 1));
      if ((value.indexOf('"') === 0 && value.lastIndexOf('"') === value.length - 1) ||
          (value.indexOf("'") === 0 && value.lastIndexOf("'") === value.length - 1)) {
        value = value.substring(1, value.length - 1);
      }
      if (key.length) {
        result.values[key] = value;
        result.keys.push(key);
      }
    }
    result.keys.sort();
    return result;
  }

  function environmentHasValue(name) {
    try {
      return trim(System.getenv(name)).length > 0;
    } catch (_ignoreEnvironmentValue) {
      return false;
    }
  }

  function fileHasContent(file) {
    try {
      return file !== null && file.isFile() && Number(file.length()) > 2;
    } catch (_ignoreFileContent) {
      return false;
    }
  }

  function authenticationInfo(configured, method, action, status) {
    return {
      configured: configured === true,
      status: trim(status) || (configured === true ? "configured" : "missing"),
      method: configured === true ? String(method || "configured") : "",
      action: configured === true ? "" : String(action || "")
    };
  }

  function decodeJwtPayload(token) {
    try {
      var parts = trim(token).split(".");
      if (parts.length < 2) {
        return null;
      }
      var bytes = Base64.getUrlDecoder().decode(String(parts[1]));
      return parseJsonSafe(String(new Packages.java.lang.String(bytes, StandardCharsets.UTF_8)), null);
    } catch (_ignoreJwtPayload) {
      return null;
    }
  }

  function codexAuthFileState(file) {
    if (!fileHasContent(file)) {
      return { exists: false, expired: false, expiresAt: 0, updatedAt: 0 };
    }
    var parsed = readJsonFile(file) || {};
    var tokens = parsed.tokens || {};
    var payload = decodeJwtPayload(tokens.access_token);
    var expiresAt = payload && Number(payload.exp) > 0 ? Number(payload.exp) * 1000 : 0;
    return {
      exists: true,
      expired: expiresAt > 0 && expiresAt <= now() + 60000,
      expiresAt: expiresAt,
      updatedAt: Number(file.lastModified() || 0),
      hasRefreshToken: trim(tokens.refresh_token).length > 0
    };
  }

  function inspectCodexAuthentication(codexHome) {
    if (environmentHasValue("OPENAI_API_KEY")) {
      return authenticationInfo(true, "environment", "");
    }
    var homes = [];
    if (trim(codexHome).length) {
      homes.push(new File(trim(codexHome)));
    }
    homes.push(new File(String(System.getProperty("user.home")), ".codex"));
    var firstExpired = null;
    var seenHomes = {};
    for (var i = 0; i < homes.length; i++) {
      var homePath = filePath(homes[i]);
      if (seenHomes[homePath]) {
        continue;
      }
      seenHomes[homePath] = true;
      var scoped = i === 0 && trim(codexHome).length > 0;
      var chatAuth = codexAuthFileState(new File(homes[i], "auth.json"));
      if (chatAuth.exists) {
        if (chatAuth.expired) {
          var expired = authenticationInfo(false, "", "codex_login", "expired");
          expired.expiresAt = chatAuth.expiresAt;
          expired.hasRefreshToken = chatAuth.hasRefreshToken === true;
          expired.home = homePath;
          if (firstExpired === null) {
            firstExpired = expired;
          }
          continue;
        }
        var chat = authenticationInfo(true, scoped ? "scoped_home" : "user_home", "");
        chat.home = homePath;
        chat.expiresAt = chatAuth.expiresAt;
        chat.updatedAt = chatAuth.updatedAt;
        return chat;
      }
      if (fileHasContent(new File(homes[i], "auth.json.api"))) {
        var api = authenticationInfo(true, scoped ? "scoped_home" : "user_home", "");
        api.home = homePath;
        return api;
      }
    }
    return firstExpired !== null ? firstExpired : authenticationInfo(false, "", "codex_login");
  }

  function codexDoctorAuthentication(options, codexHome, commandPath, forceCheck) {
    var authentication = inspectCodexAuthentication(codexHome);
    if ((authentication.status !== "expired" && forceCheck !== true) || !trim(commandPath).length) {
      return authentication;
    }
    var probeHome = trim(authentication.home) || trim(codexHome);
    var probe = runCommandCaptured([trim(commandPath), "doctor", "--json"], {
      timeoutMs: intValue(options && options.codexAuthCheckTimeoutMs, 20000, 3000, 60000),
      env: codexRuntimeEnv(options || {}, probeHome)
    });
    var output = String((probe.stdout || "") + "\n" + (probe.stderr || ""));
    var lower = output.toLowerCase();
    var refreshed = inspectCodexAuthentication(codexHome);
    var authFailure = lower.indexOf("failed to refresh token") >= 0 ||
      lower.indexOf("please log out and sign in again") >= 0 ||
      lower.indexOf("authentication expired") >= 0 ||
      lower.indexOf("invalid_grant") >= 0;
    if (authFailure) {
      authentication.checked = true;
      authentication.checkMethod = "doctor";
      authentication.status = "expired";
      return authentication;
    }
    var report = parseJsonSafe(probe.stdout, null);
    var checks = report && report.checks ? report.checks : {};
    var credentials = checks["auth.credentials"] || {};
    var providerReachability = checks["network.provider_reachability"] || {};
    var credentialsOk = trim(credentials.status).toLowerCase() === "ok";
    var providerOk = trim(providerReachability.status).toLowerCase() === "ok";
    if (refreshed.configured === true && (forceCheck !== true || (credentialsOk && providerOk))) {
      refreshed.checked = true;
      refreshed.checkMethod = "doctor";
      return refreshed;
    }
    var websocket = checks["network.websocket_reachability"] || {};
    if (credentialsOk && (providerOk || trim(websocket.status).toLowerCase() === "ok")) {
      authentication = authenticationInfo(true, "scoped_home", "");
      authentication.checked = true;
      authentication.checkMethod = "doctor";
      return authentication;
    }
    authentication.checked = true;
    authentication.checkMethod = "doctor";
    authentication.configured = false;
    authentication.method = "";
    authentication.action = "codex_login";
    authentication.status = probe.error === "timeout" ? "check_timeout" : (authentication.status === "expired" ? "expired" : "invalid");
    return authentication;
  }

  function codexAppServerAuthenticationProbe(options, codexHome, commandPath) {
    var startedAt = now();
    var result = {
      checked: true,
      valid: false,
      unauthorized: false,
      error: "",
      durationMs: 0
    };
    var process = null;
    var writer = null;
    var reader = null;
    var errFile = null;
    var transcript = "";
    try {
      errFile = File.createTempFile("c8o-codex-auth-probe-", ".log");
      var pb = new ProcessBuilder(toJavaList([trim(commandPath), "app-server", "--listen", "stdio://"]));
      applyEngineProxyEnvironment(pb.environment(), "https://chatgpt.com");
      envObjectToMap(pb.environment(), codexRuntimeEnv(options || {}, codexHome));
      pb.redirectError(errFile);
      process = pb.start();
      writer = new BufferedWriter(new OutputStreamWriter(process.getOutputStream(), StandardCharsets.UTF_8));
      reader = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8));
      var send = function (message) {
        writer.write(JSON.stringify(message));
        writer.newLine();
        writer.flush();
      };
      send({ id: 1, method: "initialize", params: { clientInfo: { name: "lib_ConvertigoAgentBridge", version: "0.1.0" }, capabilities: null } });
      var initialized = false;
      var deadline = now() + intValue(options && options.codexAuthCheckTimeoutMs, 20000, 3000, 60000);
      while (now() < deadline && processAlive(process)) {
        if (!reader.ready()) {
          Thread.sleep(25);
          continue;
        }
        var line = reader.readLine();
        if (line === null) {
          break;
        }
        transcript += line + "\n";
        var message = parseJsonSafe(line, null);
        if (message === null) {
          continue;
        }
        if (!initialized && String(message.id) === "1") {
          if (message.error) {
            result.error = trim(message.error.message || JSON.stringify(message.error));
            break;
          }
          initialized = true;
          send({ method: "initialized" });
          send({ id: 2, method: "account/rateLimits/read" });
          continue;
        }
        if (initialized && String(message.id) === "2") {
          if (message.error) {
            result.error = trim(message.error.message || JSON.stringify(message.error));
          } else {
            result.valid = true;
          }
          break;
        }
      }
      if (!result.valid && !result.error.length) {
        result.error = now() >= deadline ? "timeout" : "Codex authentication probe ended without a response";
      }
    } catch (e) {
      result.error = String(e);
    } finally {
      try { if (writer !== null) { writer.close(); } } catch (_ignoreAuthProbeWriterClose) {}
      try { if (reader !== null) { reader.close(); } } catch (_ignoreAuthProbeReaderClose) {}
      try { if (process !== null && processAlive(process)) { process.destroyForcibly(); } } catch (_ignoreAuthProbeDestroy) {}
      try {
        if (errFile !== null && errFile.isFile()) {
          transcript += "\n" + readTextFile(errFile);
        }
      } catch (_ignoreAuthProbeStderr) {}
      try { if (errFile !== null) { Files.deleteIfExists(errFile.toPath()); } } catch (_ignoreAuthProbeDelete) {}
    }
    var lower = String(transcript + "\n" + result.error).toLowerCase();
    result.unauthorized = lower.indexOf("401 unauthorized") >= 0 ||
      lower.indexOf("refresh token was revoked") >= 0 ||
      lower.indexOf("failed to refresh token") >= 0 ||
      lower.indexOf("invalid_grant") >= 0 ||
      lower.indexOf("please log out and sign in again") >= 0;
    result.durationMs = now() - startedAt;
    return result;
  }

  function verifiedCodexAuthentication(options, codexHome, commandPath, forceCheck) {
    var authentication = codexDoctorAuthentication(options, codexHome, commandPath, forceCheck);
    if (authentication.configured !== true || !trim(commandPath).length) {
      return authentication;
    }
    var authHome = trim(authentication.home) || trim(codexHome);
    var cacheOptions = {};
    options = options || {};
    for (var key in options) {
      if (Object.prototype.hasOwnProperty.call(options, key)) {
        cacheOptions[key] = options[key];
      }
    }
    cacheOptions.updateCheckCacheMs = intValue(options.codexAuthCheckCacheMs, DEFAULT_RUNTIME_UPDATE_CACHE_MS, 60000, 86400000);
    cacheOptions.refreshUpdateCheck = forceCheck === true || boolValue(options.refreshCodexAuthCheck, false) || boolValue(options.refreshUpdateCheck, false);
    var cacheKey = "codex-auth:" + hashShort(authHome + ":" + String(authentication.updatedAt || 0));
    var probe = cachedRuntimeUpdate(cacheKey, cacheOptions, resolveWorkspaceRoot(options), function () {
      return codexAppServerAuthenticationProbe(options, authHome, commandPath);
    });
    authentication.checked = true;
    authentication.checkMethod = "app-server-rate-limits";
    authentication.check = probe;
    if (probe.unauthorized === true) {
      authentication.configured = false;
      authentication.status = "expired";
      authentication.method = "";
      authentication.action = "codex_login";
    }
    return authentication;
  }

  function vibeEnvHasKey(file, name) {
    try {
      var parsed = readEnvFile(file);
      return trim(parsed.values[name]).length > 0;
    } catch (_ignoreVibeEnv) {
      return false;
    }
  }

  function vibeEnvHasApiKey(file) {
    return vibeEnvHasKey(file, "MISTRAL_API_KEY");
  }

  function writeEnvFileValue(file, name, value) {
    var lines = [];
    try {
      if (file.isFile()) {
        lines = readTextFile(file).split(/\r?\n/);
      }
    } catch (_ignoreEnvRead) {}
    var out = [];
    var replaced = false;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var body = trim(line);
      if (body.indexOf("export ") === 0) {
        body = trim(body.substring(7));
      }
      if (body.indexOf(name + "=") === 0) {
        if (!replaced) {
          out.push(name + "=" + value);
          replaced = true;
        }
        continue;
      }
      if (line.length || i < lines.length - 1) {
        out.push(line);
      }
    }
    if (!replaced) {
      out.push(name + "=" + value);
    }
    ensureDirectory(file.getParentFile());
    writeTextFile(file, out.join("\n").replace(/\n*$/, "") + "\n");
    try {
      file.setReadable(false, false);
      file.setReadable(true, true);
      file.setWritable(false, false);
      file.setWritable(true, true);
    } catch (_ignoreEnvPermissions) {}
  }

  function rejectedGatewayKeyAuthentication(options) {
    // A key is present but the gateway answered 401/403: say so, or the user keeps looking for
    // a missing key while a wrong one is silently sent.
    var info = authenticationInfo(false, "", "convertigo_key");
    info.status = "rejected";
    info.message = "The Convertigo gateway rejected the agent key. Replace the first line of " + filePath(convertigoGatewayKeyFile(options)) + " with a valid key.";
    return info;
  }

  function inspectVibeAuthentication(vibeHome, profile) {
    if (profile === "convertigo") {
      if (environmentHasValue(CONVERTIGO_LLM_API_KEY_ENV)) {
        return authenticationInfo(true, "environment", "");
      }
      if (trim(vibeHome).length && vibeEnvHasKey(new File(trim(vibeHome), ".env"), CONVERTIGO_LLM_API_KEY_ENV)) {
        return authenticationInfo(true, "scoped_home", "");
      }
      if (readConvertigoGatewayKeyFile(null).length) {
        return authenticationInfo(true, "key_file", "");
      }
      return authenticationInfo(false, "", "convertigo_key");
    }
    if (environmentHasValue("MISTRAL_API_KEY")) {
      return authenticationInfo(true, "environment", "");
    }
    if (trim(vibeHome).length && vibeEnvHasApiKey(new File(trim(vibeHome), ".env"))) {
      return authenticationInfo(true, "scoped_home", "");
    }
    var userEnv = new File(new File(String(System.getProperty("user.home")), ".vibe"), ".env");
    if (vibeEnvHasApiKey(userEnv)) {
      return authenticationInfo(true, "user_home", "");
    }
    if (vibeKeychainHasApiKey()) {
      return authenticationInfo(true, "keychain", "");
    }
    return authenticationInfo(false, "", "vibe_login");
  }

  var VIBE_KEYCHAIN_SERVICE = "ai.mistral.vibe";

  function vibeKeychainHasApiKey() {
    // Vibe itself stores the key in the macOS Keychain when `vibe --setup` is used on the workstation.
    if (!isMacOsHost()) {
      return false;
    }
    try {
      var probe = runCommand(["/usr/bin/security", "find-generic-password", "-s", VIBE_KEYCHAIN_SERVICE, "-a", "MISTRAL_API_KEY"], { timeoutMs: 8000 });
      return probe.ok === true;
    } catch (_ignoreVibeKeychain) {
      return false;
    }
  }

  function projectWorkspaceRoot(projectName) {
    var name = trim(projectName);
    if (!name.length) {
      return "";
    }
    try {
      var project = Packages.com.twinsoft.convertigo.engine.Engine.theApp.databaseObjectsManager.getProjectByName(name);
      if (project && project.getDirFile) {
        var workspace = workspaceRootFromProjectDir(project.getDirFile());
        if (workspace.length) {
          return workspace;
        }
      }
    } catch (_ignoreTargetProjectDir) {}
    try {
      var project2 = Packages.com.twinsoft.convertigo.engine.Engine.theApp.databaseObjectsManager.getProjectByName(name);
      if (project2 && project2.getDirPath) {
        var workspace2 = workspaceRootFromProjectDir(project2.getDirPath());
        if (workspace2.length) {
          return workspace2;
        }
      }
    } catch (_ignoreTargetProjectPath) {}
    return "";
  }

  function defaultWorkspaceRoot(projectName) {
    var engineWorkspace = engineWorkspaceRoot();
    if (engineWorkspace.length) {
      return engineWorkspace;
    }
    var targetWorkspace = projectWorkspaceRoot(projectName);
    if (targetWorkspace.length) {
      return targetWorkspace;
    }
    try {
      if (context && context.project && context.project.getDirFile) {
        var contextWorkspace = workspaceRootFromProjectDir(context.project.getDirFile());
        if (contextWorkspace.length) {
          return contextWorkspace;
        }
      }
    } catch (_ignoreProjectDir) {}
    try {
      if (context && context.project && context.project.getDirPath) {
        var contextWorkspace2 = workspaceRootFromProjectDir(context.project.getDirPath());
        if (contextWorkspace2.length) {
          return contextWorkspace2;
        }
      }
    } catch (_ignoreProjectPath) {}
    return filePath(new File(System.getProperty("user.home"), "convertigo"));
  }

  function workspaceProjectName(options) {
    options = options || {};
    return trim(options.projectId || options.projectName || options.targetProject || options.primaryProject);
  }

  function resolveWorkspaceRoot(options) {
    options = options || {};
    var explicit = trim(options.workspaceRoot);
    if (explicit.length) {
      return normalizeWorkspaceRootPath(explicit);
    }
    return defaultWorkspaceRoot(workspaceProjectName(options));
  }

  function normalizeDirectory(value, fallback, baseDir) {
    var text = trim(value);
    if (!text.length) {
      text = fallback;
    }
    var file = new File(text);
    if (!file.isAbsolute()) {
      file = new File(trim(baseDir) || trim(fallback), text);
    }
    return filePath(file);
  }

  function normalizeScope(value) {
    var scope = trim(value).toLowerCase();
    if (!scope.length) {
      return "shared";
    }
    if (scope === "conv" || scope === "chat" || scope === "thread") {
      return "conversation";
    }
    if (scope === "global" || scope === "studio") {
      return "shared";
    }
    if (scope === "explicit" || scope === "shared" || scope === "user" || scope === "conversation") {
      return scope;
    }
    return "shared";
  }

  function normalizeCodexHomeScope(value) {
    var scope = trim(value).toLowerCase();
    if (!scope.length) {
      return "user";
    }
    if (scope === "none" || scope === "user-home" || scope === "user_home" || scope === "home") {
      return "default";
    }
    if (scope === "conv" || scope === "chat" || scope === "thread") {
      return "conversation";
    }
    if (scope === "global" || scope === "studio") {
      return "shared";
    }
    if (scope === "explicit" || scope === "default" || scope === "shared" || scope === "user" || scope === "conversation") {
      return scope;
    }
    return "user";
  }

  function normalizeProvider(value) {
    var provider = trim(value).toLowerCase();
    if (provider === "codex-cli" || provider === "openai-codex") {
      return "codex";
    }
    if (provider === "mistral-vibe" || provider === "vibe-acp") {
      return "vibe";
    }
    if (provider === "claude-code" || provider === "anthropic-claude" || provider === "anthropic" || provider === "claude-cli") {
      return "claude";
    }
    return provider.length ? provider.replace(/[^a-z0-9_.-]/g, "_") : "vibe";
  }

  function providerLabel(value) {
    var provider = normalizeProvider(value);
    if (provider === "codex") {
      return "Codex";
    }
    if (provider === "vibe") {
      return "Vibe";
    }
    if (provider === "claude") {
      return "Claude";
    }
    return provider;
  }

  function stableId(prefix, value) {
    var text = trim(value) || "default";
    var uuid = UUID.nameUUIDFromBytes(new java.lang.String(text).getBytes(StandardCharsets.UTF_8));
    return String(prefix) + "-" + String(uuid);
  }

  function hashShort(value) {
    var md = MessageDigest.getInstance("SHA-256");
    var bytes = md.digest(new java.lang.String(String(value || "")).getBytes(StandardCharsets.UTF_8));
    var out = "";
    for (var i = 0; i < bytes.length; i++) {
      var n = Number(bytes[i]);
      if (n < 0) {
        n += 256;
      }
      if (n < 16) {
        out += "0";
      }
      out += n.toString(16);
    }
    return out.substring(0, 16);
  }

  function safePathPart(value) {
    var text = String(value || "").replace(/[^A-Za-z0-9_.-]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
    return text.length ? text : "_";
  }

  function userPathSlug(value) {
    var text = trim(value);
    if (!text.length || text.toLowerCase() === "studio") {
      return "studio";
    }
    var readable = safePathPart(text.toLowerCase());
    if (!readable.length || readable === "_") {
      readable = "user";
    }
    if (readable.length > 80) {
      readable = readable.substring(0, 80).replace(/[_.-]+$/g, "");
    }
    return readable + "--" + hashShort(text);
  }

  function getSessionAttribute(name) {
    try {
      if (context && context.httpSession) {
        var value = context.httpSession.getAttribute(name);
        if (value !== null && typeof value !== "undefined") {
          return String(value);
        }
      }
    } catch (_ignoreSessionAttr) {}
    return "";
  }

  function setSessionAttribute(name, value) {
    try {
      if (context && context.httpSession) {
        context.httpSession.setAttribute(name, String(value));
      }
    } catch (_ignoreSessionAttrSet) {}
  }

  function contextUserId() {
    try {
      if (context && typeof context.getAuthenticatedUser === "function") {
        var authenticated = context.getAuthenticatedUser();
        if (authenticated !== null && typeof authenticated !== "undefined" && trim(authenticated).length) {
          return String(authenticated);
        }
      }
    } catch (_ignoreGetAuthenticatedUser) {}
    try {
      if (context && typeof context.authenticatedUser !== "undefined" && trim(context.authenticatedUser).length) {
        return String(context.authenticatedUser);
      }
    } catch (_ignoreAuthenticatedUser) {}
    return trim(getSessionAttribute("authenticatedUser") || getSessionAttribute("user") || getSessionAttribute("username"));
  }

  function resolveConversationIdOption(options) {
    var id = trim(options.conversationId);
    if (id.length) {
      setSessionAttribute(SESSION_CONVERSATION_ATTR, id);
      return id;
    }
    var stored = getSessionAttribute(SESSION_CONVERSATION_ATTR);
    if (stored.length) {
      return stored;
    }
    id = "conversation-" + String(UUID.randomUUID());
    setSessionAttribute(SESSION_CONVERSATION_ATTR, id);
    return id;
  }

  function resolveProjectIdOption(options) {
    options = options || {};
    var id = trim(options.projectId || options.projectName || options.targetProject || options.primaryProject);
    if (id.length) {
      return id;
    }
    try {
      if (context && context.project && context.project.getName) {
        var contextProject = String(context.project.getName());
        if (!/^(lib_ConvertigoAgentBridge|lib_ConvertigoAssistant|lib_ConvertigoMCP)$/.test(contextProject)) {
          return contextProject;
        }
      }
    } catch (_ignoreProjectName) {}
    return "";
  }

  function appendProjectPath(basePath, id) {
    if (!trim(id).length) {
      return basePath;
    }
    return childPath(childPath(basePath, "projects"), stableId("project", id));
  }

  function resolveVibeHome(options, installDir) {
    options = options || {};
    var explicit = trim(options.vibeHome);
    if (explicit.length) {
      return {
        scope: "explicit",
        path: filePath(new File(explicit)),
        explicit: true,
        userId: trim(options.userId),
        conversationId: trim(options.conversationId),
        projectId: trim(options.projectId),
        error: ""
      };
    }

    var scope = normalizeScope(options.vibeHomeScope || options.homeScope || options.scope);
    var project = resolveProjectIdOption(options);
    if (scope === "shared") {
      return {
        scope: "shared",
        path: childPath(installDir, isConvertigoGatewayProfile(options) ? ".vibe-home-convertigo" : ".vibe-home"),
        explicit: false,
        userId: "",
        conversationId: "",
        projectId: project,
        error: ""
      };
    }

    var root = childPath(installDir, isConvertigoGatewayProfile(options) ? "homes-convertigo" : "homes");
    var user = trim(options.userId) || contextUserId();
    if (scope === "user") {
      if (!user.length) {
        return {
          scope: "user",
          path: "",
          explicit: false,
          userId: "",
          conversationId: "",
          projectId: project,
          error: "userId is required for user scoped VIBE_HOME"
        };
      }
      var userBase = childPath(childPath(root, "users"), userPathSlug(user));
      return {
        scope: "user",
        path: childPath(userBase, ".vibe-home"),
        explicit: false,
        userId: user,
        conversationId: "",
        projectId: project,
        error: ""
      };
    }

    var conv = resolveConversationIdOption(options);
    var convBase;
    if (user.length) {
      convBase = childPath(childPath(root, "users"), userPathSlug(user));
      convBase = childPath(childPath(convBase, "conversations"), stableId("conversation", conv));
    } else {
      convBase = childPath(childPath(root, "conversations"), stableId("conversation", conv));
    }
    return {
      scope: "conversation",
      path: childPath(convBase, ".vibe-home"),
      explicit: false,
      userId: user,
      conversationId: conv,
      projectId: project,
      error: ""
    };
  }

  function resolveCodexHome(options, installDir) {
    options = options || {};
    var explicit = trim(options.codexHome || options.agentHome);
    if (explicit.length) {
      return {
        scope: "explicit",
        path: filePath(new File(explicit)),
        explicit: true,
        userId: trim(options.userId),
        conversationId: trim(options.conversationId),
        projectId: trim(options.projectId),
        error: ""
      };
    }

    var scopeOption = trim(options.codexHomeScope || options.homeScope || options.scope);
    if (!scopeOption.length && resolvePlaywrightMcpCdpEndpoint(options).length) {
      scopeOption = "conversation";
    }
    var scope = normalizeCodexHomeScope(scopeOption);
    var project = resolveProjectIdOption(options);
    if (scope === "default") {
      return {
        scope: "default",
        path: "",
        explicit: false,
        userId: "",
        conversationId: "",
        projectId: project,
        error: ""
      };
    }
    if (scope === "shared") {
      return {
        scope: "shared",
        path: childPath(installDir, "codex-home"),
        explicit: false,
        userId: "",
        conversationId: "",
        projectId: project,
        error: ""
      };
    }

    var root = childPath(installDir, "homes");
    var user = trim(options.userId) || contextUserId();
    if (scope === "user") {
      if (!user.length) {
        return {
          scope: "user",
          path: "",
          explicit: false,
          userId: "",
          conversationId: "",
          projectId: project,
          error: "userId is required for user scoped CODEX_HOME"
        };
      }
      var userBase = childPath(childPath(root, "users"), userPathSlug(user));
      return {
        scope: "user",
        path: childPath(userBase, "codex-home"),
        explicit: false,
        userId: user,
        conversationId: "",
        projectId: project,
        error: ""
      };
    }

    var conv = resolveConversationIdOption(options);
    var convBase;
    if (user.length) {
      convBase = childPath(childPath(root, "users"), userPathSlug(user));
      convBase = childPath(childPath(convBase, "conversations"), stableId("conversation", conv));
    } else {
      convBase = childPath(childPath(root, "conversations"), stableId("conversation", conv));
    }
    return {
      scope: "conversation",
      path: childPath(convBase, "codex-home"),
      explicit: false,
      userId: user,
      conversationId: conv,
      projectId: project,
      error: ""
    };
  }

  function getServerStore() {
    try {
      if (context && context.server) {
        return context.server;
      }
    } catch (_ignoreContextServer) {}
    try {
      if (typeof server !== "undefined" && server) {
        return server;
      }
    } catch (_ignoreServer) {}
    return null;
  }

  function getRegistry() {
    var store = getServerStore();
    if (store !== null) {
      var registry = store.get(REGISTRY_KEY);
      if (registry === null || typeof registry === "undefined") {
        registry = new ConcurrentHashMap();
        store.set(REGISTRY_KEY, registry);
      }
      return registry;
    }
    if (!C8O.agentBridge._fallbackRegistry) {
      C8O.agentBridge._fallbackRegistry = new ConcurrentHashMap();
    }
    return C8O.agentBridge._fallbackRegistry;
  }

  function getRuntimeUpdateCache() {
    var store = getServerStore();
    if (store !== null) {
      var cache = store.get(RUNTIME_UPDATE_CACHE_KEY);
      if (cache === null || typeof cache === "undefined") {
        cache = new ConcurrentHashMap();
        store.set(RUNTIME_UPDATE_CACHE_KEY, cache);
      }
      return cache;
    }
    if (!C8O.agentBridge._fallbackRuntimeUpdateCache) {
      C8O.agentBridge._fallbackRuntimeUpdateCache = new ConcurrentHashMap();
    }
    return C8O.agentBridge._fallbackRuntimeUpdateCache;
  }

  function runtimeUpdateCacheFile(workspaceRoot) {
    var root = trim(workspaceRoot);
    return root.length ? new File(childPath(root, "agents"), RUNTIME_UPDATE_CACHE_FILE) : null;
  }

  function readPersistentRuntimeUpdateCache(workspaceRoot) {
    var file = runtimeUpdateCacheFile(workspaceRoot);
    var value = file !== null ? readJsonFile(file) : null;
    if (value === null || typeof value !== "object") {
      value = {};
    }
    if (value.checks === null || typeof value.checks !== "object") {
      value.checks = {};
    }
    if (value.providers === null || typeof value.providers !== "object") {
      value.providers = {};
    }
    if (value.preferences === null || typeof value.preferences !== "object") {
      value.preferences = {};
    }
    value.version = 4;
    return {
      file: file,
      value: value
    };
  }

  function providerDefaultReasoning(provider) {
    provider = provider || {};
    var models = provider.models || [];
    var defaultModel = trim(provider.defaultModel);
    for (var i = 0; i < models.length; i++) {
      if (trim(models[i] && models[i].id) === defaultModel) {
        return trim(models[i] && models[i].defaultReasoning);
      }
    }
    return models.length ? trim(models[0] && models[0].defaultReasoning) : "";
  }

  function agentPreferenceKey(options) {
    options = options || {};
    var user = trim(options.userId) || contextUserId() || "studio";
    var profile = normalizeSkillProfile(options) || "generalist";
    return userPathSlug(user) + ":" + userPathSlug(profile);
  }

  function readPersistentAgentPreferences(workspaceRoot, options) {
    try {
      var persistent = readPersistentRuntimeUpdateCache(workspaceRoot);
      return persistent.value.preferences[agentPreferenceKey(options)] || null;
    } catch (_ignorePersistentAgentPreferencesRead) {}
    return null;
  }

  function writePersistentAgentPreferences(workspaceRoot, options, preferences) {
    var persistent = readPersistentRuntimeUpdateCache(workspaceRoot);
    if (persistent.file === null) {
      return;
    }
    var lock = null;
    try {
      lock = acquireFileLock(new File(persistent.file.getParentFile(), RUNTIME_UPDATE_CACHE_FILE + ".lock"), 5000);
      persistent = readPersistentRuntimeUpdateCache(workspaceRoot);
      persistent.value.preferences[agentPreferenceKey(options)] = preferences;
      writeTextFile(persistent.file, JSON.stringify(persistent.value, null, 2) + "\n");
    } catch (_ignorePersistentAgentPreferencesWrite) {
    } finally {
      if (lock !== null) {
        lock.release();
      }
    }
  }

  function validatedAgentPreferences(preferences, providers) {
    preferences = preferences || {};
    providers = providers || [];
    var providerId = normalizeProvider(preferences.provider);
    var provider = null;
    for (var i = 0; i < providers.length; i++) {
      if (normalizeProvider(providers[i] && providers[i].id) === providerId && providers[i].ready === true) {
        provider = providers[i];
        break;
      }
    }
    if (provider === null) {
      return null;
    }
    var models = provider.models || [];
    var modelId = trim(preferences.model);
    var model = null;
    for (var j = 0; j < models.length; j++) {
      if (trim(models[j] && models[j].id) === modelId) {
        model = models[j];
        break;
      }
    }
    if (model === null) {
      modelId = trim(provider.defaultModel);
      for (var k = 0; k < models.length; k++) {
        if (trim(models[k] && models[k].id) === modelId) {
          model = models[k];
          break;
        }
      }
    }
    if (model === null && models.length) {
      model = models[0];
      modelId = trim(model.id);
    }
    var reasoning = trim(preferences.reasoning);
    var reasoningLevels = model && model.reasoningLevels ? model.reasoningLevels : [];
    var reasoningValid = !reasoning.length;
    for (var r = 0; r < reasoningLevels.length; r++) {
      if (trim(reasoningLevels[r] && reasoningLevels[r].id) === reasoning) {
        reasoningValid = true;
        break;
      }
    }
    if (!reasoningValid) {
      reasoning = trim(model && model.defaultReasoning);
    }
    if (!(provider.supports && provider.supports.reasoning === true)) {
      reasoning = "";
    }
    return {
      confirmed: preferences.confirmed === true,
      provider: providerId,
      model: modelId,
      reasoning: reasoning,
      serviceTier: trim(preferences.serviceTier),
      updatedAt: Number(preferences.updatedAt || 0)
    };
  }

  function compactProviderSettingsCache(provider) {
    provider = provider || {};
    return {
      cachedAt: now(),
      defaults: {
        model: trim(provider.defaultModel),
        reasoning: providerDefaultReasoning(provider)
      },
      models: provider.models || [],
      reasoningMode: String(provider.reasoningMode || ""),
      supports: provider.supports || {}
    };
  }

  function providerSettingsCacheKey(providerId, profilePath) {
    var provider = normalizeProvider(providerId);
    var profile = trim(profilePath);
    return provider === "vibe" && profile.length ? provider + ":" + hashShort(canonicalFilePath(new File(profile))) : provider;
  }

  function providerCacheKey(provider) {
    provider = provider || {};
    return trim(provider.settingsCacheKey) || normalizeProvider(provider.id);
  }

  function readPersistentProviderSettingsCache(workspaceRoot, providerId, cacheKey) {
    try {
      var persistent = readPersistentRuntimeUpdateCache(workspaceRoot);
      var key = trim(cacheKey) || normalizeProvider(providerId);
      var cached = persistent.value.providers[key];
      if ((!cached || !cached.models || !cached.models.length) && key !== normalizeProvider(providerId) && normalizeProvider(providerId) !== "vibe") {
        cached = persistent.value.providers[normalizeProvider(providerId)];
      }
      if (cached && cached.models && cached.models.length) {
        return cached;
      }
    } catch (_ignorePersistentProviderSettingsCacheRead) {}
    return null;
  }

  function writePersistentProviderSettingsCache(workspaceRoot, providers) {
    var persistent = readPersistentRuntimeUpdateCache(workspaceRoot);
    if (persistent.file === null) {
      return;
    }
    var lock = null;
    try {
      lock = acquireFileLock(new File(persistent.file.getParentFile(), RUNTIME_UPDATE_CACHE_FILE + ".lock"), 5000);
      persistent = readPersistentRuntimeUpdateCache(workspaceRoot);
      providers = providers || [];
      for (var i = 0; i < providers.length; i++) {
        var provider = providers[i] || {};
        if (provider.source && (provider.source.discoveryError || provider.source.modelCatalogRefreshRequired)) {
          continue;
        }
        var cacheKey = providerCacheKey(provider);
        if (cacheKey.length && provider.models && provider.models.length) {
          persistent.value.providers[cacheKey] = compactProviderSettingsCache(provider);
          if (cacheKey.indexOf("vibe:") === 0) {
            delete persistent.value.providers.vibe;
          }
        }
      }
      writeTextFile(persistent.file, JSON.stringify(persistent.value, null, 2) + "\n");
    } catch (_ignorePersistentProviderSettingsCacheWrite) {
    } finally {
      if (lock !== null) {
        lock.release();
      }
    }
  }

  function invalidatePersistentProviderSettingsCache(workspaceRoot, providerId, cacheKey) {
    var persistent = readPersistentRuntimeUpdateCache(workspaceRoot);
    if (persistent.file === null) {
      return false;
    }
    var lock = null;
    try {
      lock = acquireFileLock(new File(persistent.file.getParentFile(), RUNTIME_UPDATE_CACHE_FILE + ".lock"), 5000);
      persistent = readPersistentRuntimeUpdateCache(workspaceRoot);
      var removed = false;
      var key = trim(cacheKey) || normalizeProvider(providerId);
      if (Object.prototype.hasOwnProperty.call(persistent.value.providers, key)) {
        delete persistent.value.providers[key];
        removed = true;
      }
      var legacyKey = normalizeProvider(providerId);
      if (key !== legacyKey && Object.prototype.hasOwnProperty.call(persistent.value.providers, legacyKey)) {
        delete persistent.value.providers[legacyKey];
        removed = true;
      }
      if (removed) {
        writeTextFile(persistent.file, JSON.stringify(persistent.value, null, 2) + "\n");
      }
      return removed;
    } catch (_ignorePersistentProviderSettingsCacheInvalidation) {
      return false;
    } finally {
      if (lock !== null) {
        lock.release();
      }
    }
  }

  // Re-applies the live gateway offer on a model list that may come from an older ACP catalog:
  // only offered models, each with the reasoning levels it accepts.
  function applyGatewayOfferToProvider(provider) {
    if (!provider || normalizeProvider(provider.id) !== "convertigo" || !provider.gateway || !provider.gateway.models || !provider.gateway.models.length) {
      return provider;
    }
    var aliases = provider.gateway.models, efforts = provider.gateway.efforts || {}, known = {}, models = [];
    var source = provider.models || [];
    for (var i = 0; i < source.length; i++) { known[source[i].id] = source[i]; }
    for (var a = 0; a < aliases.length; a++) {
      var alias = aliases[a];
      var model = known[alias] || { id: alias, label: alias, configuredName: alias, provider: "convertigo", defaultReasoning: "", reasoningLevels: [], serviceTiers: [], speedTiers: [] };
      if (Object.prototype.hasOwnProperty.call(efforts, alias)) {
        var accepted = efforts[alias];
        var offeredLevels = (model.reasoningLevels || []).filter(function (level) {
          var id = String(level.id).toLowerCase();
          return id === "off" || id === "none" || accepted.indexOf(id) >= 0;
        });
        for (var l = 0; l < accepted.length; l++) {
          var present = false;
          for (var o = 0; o < offeredLevels.length; o++) { if (String(offeredLevels[o].id).toLowerCase() === accepted[l]) { present = true; } }
          if (!present) { offeredLevels.push({ id: accepted[l], label: accepted[l], description: "Accepted by this gateway model" }); }
        }
        model.reasoningLevels = offeredLevels;
        model.defaultReasoning = gatewayEffortFor(model.defaultReasoning || CONVERTIGO_LLM_GATEWAY_THINKING, accepted);
      }
      model.provider = "convertigo";
      models.push(model);
    }
    provider.models = models;
    if (aliases.indexOf(trim(provider.defaultModel)) < 0) { provider.defaultModel = models[0].id; }
    return provider;
  }

  function hydrateProviderSettingsFromCache(workspaceRoot, provider, preferCached) {
    provider = provider || {};
    if (!preferCached && provider.models && provider.models.length) {
      return provider;
    }
    var cached = readPersistentProviderSettingsCache(workspaceRoot, provider.id, providerCacheKey(provider));
    if (cached === null) {
      return provider;
    }
    provider.models = cached.models || [];
    provider.defaultModel = trim(cached.defaults && cached.defaults.model);
    provider.reasoningMode = String(cached.reasoningMode || provider.reasoningMode || "");
    provider.supports = cached.supports || provider.supports || {};
    provider.source = provider.source || {};
    provider.source.settingsCached = true;
    provider.source.settingsCachedAt = provider.source.modelCatalogRefreshRequired ? 0 : Number(cached.cachedAt || 0);
    return applyGatewayOfferToProvider(provider);
  }

  function requireCachedProviderConfiguration(provider) {
    provider = provider || {};
    if (provider.ready !== true) {
      return provider;
    }
    var models = provider.models || [];
    var defaultModel = trim(provider.defaultModel);
    var defaultModelFound = false;
    for (var i = 0; i < models.length; i++) {
      if (trim(models[i] && models[i].id) === defaultModel) {
        defaultModelFound = true;
        break;
      }
    }
    if (!models.length || !defaultModel.length || !defaultModelFound) {
      provider.ready = false;
      provider.status = "configuration_required";
      provider.source = provider.source || {};
      provider.source.error = "Provider model catalog is not cached";
    }
    return provider;
  }

  function requireProviderAuthentication(provider) {
    provider = provider || {};
    var authentication = provider.authentication || authenticationInfo(false, "", "authenticate");
    if (provider.runtime && provider.runtime.installed === true && authentication.configured !== true) {
      provider.ready = false;
      provider.status = "authentication_required";
      provider.source = provider.source || {};
      provider.source.error = "Provider authentication is required";
    }
    return provider;
  }

  function providerSettingsCacheFresh(provider, maxAgeMs) {
    if (provider && provider.source && provider.source.modelCatalogRefreshRequired) {
      return false;
    }
    var cachedAt = Number(provider && provider.source && provider.source.settingsCachedAt || 0);
    return cachedAt > 0 && now() - cachedAt < maxAgeMs;
  }

  function writePersistentRuntimeUpdateCache(workspaceRoot, cacheKey, loaded, nextCheckAt) {
    var persistent = readPersistentRuntimeUpdateCache(workspaceRoot);
    if (persistent.file === null) {
      return;
    }
    var lock = null;
    try {
      lock = acquireFileLock(new File(persistent.file.getParentFile(), RUNTIME_UPDATE_CACHE_FILE + ".lock"), 5000);
      persistent = readPersistentRuntimeUpdateCache(workspaceRoot);
      persistent.value.checks[cacheKey] = {
        checkedAt: Number(loaded.checkedAt || 0),
        nextCheckAt: Number(nextCheckAt || 0),
        result: loaded
      };
      writeTextFile(persistent.file, JSON.stringify(persistent.value, null, 2) + "\n");
    } catch (_ignorePersistentRuntimeUpdateCacheWrite) {
    } finally {
      if (lock !== null) {
        lock.release();
      }
    }
  }

  function readCachedRuntimeUpdate(cacheKey, workspaceRoot) {
    var cache = getRuntimeUpdateCache();
    var currentTime = now();
    try {
      var cachedText = cache.get(cacheKey);
      if (cachedText !== null && typeof cachedText !== "undefined") {
        var cached = parseJsonSafe(String(cachedText), null);
        if (cached !== null && Number(cached.nextCheckAt || 0) > currentTime) {
          cached.cached = true;
          return cached;
        }
      }
    } catch (_ignoreRuntimeUpdateCacheRead) {}
    try {
      var persistent = readPersistentRuntimeUpdateCache(workspaceRoot);
      var stored = persistent.value.checks[cacheKey];
      if (stored && Number(stored.nextCheckAt || 0) > currentTime && stored.result) {
        var persisted = stored.result;
        persisted.checkedAt = Number(stored.checkedAt || persisted.checkedAt || 0);
        persisted.nextCheckAt = Number(stored.nextCheckAt || 0);
        persisted.cached = true;
        cache.put(cacheKey, JSON.stringify(persisted));
        return persisted;
      }
    } catch (_ignorePersistentRuntimeUpdateCacheRead) {}
    return null;
  }

  function cachedRuntimeUpdate(key, options, workspaceRoot, loader) {
    options = options || {};
    var cache = getRuntimeUpdateCache();
    var cacheKey = String(key || "");
    var refresh = boolValue(options.refreshUpdateCheck, false);
    var cacheMs = intValue(options.updateCheckCacheMs, DEFAULT_RUNTIME_UPDATE_CACHE_MS, 0, 86400000);
    var currentTime = now();
    if (!refresh && cacheMs > 0) {
      var cached = readCachedRuntimeUpdate(cacheKey, workspaceRoot);
      if (cached !== null) {
        return cached;
      }
    }
    var loaded = loader();
    loaded.checkedAt = currentTime;
    loaded.nextCheckAt = cacheMs > 0 ? currentTime + cacheMs : currentTime;
    loaded.cached = false;
    try {
      cache.put(cacheKey, JSON.stringify(loaded));
    } catch (_ignoreRuntimeUpdateCacheWrite) {}
    writePersistentRuntimeUpdateCache(workspaceRoot, cacheKey, loaded, loaded.nextCheckAt);
    return loaded;
  }

  function rememberSessionHandle(handle) {
    try {
      if (context && context.httpSession) {
        context.httpSession.setAttribute(SESSION_HANDLE_ATTR, String(handle));
      }
    } catch (_ignoreSessionSet) {}
  }

  function forgetSessionHandle(handle) {
    try {
      if (context && context.httpSession) {
        var current = context.httpSession.getAttribute(SESSION_HANDLE_ATTR);
        if (current !== null && String(current) === String(handle)) {
          context.httpSession.removeAttribute(SESSION_HANDLE_ATTR);
        }
      }
    } catch (_ignoreSessionRemove) {}
  }

  function resolveHandle(handle) {
    var text = trim(handle);
    if (text.length) {
      return text;
    }
    try {
      if (context && context.httpSession) {
        var stored = context.httpSession.getAttribute(SESSION_HANDLE_ATTR);
        if (stored !== null && typeof stored !== "undefined") {
          return String(stored);
        }
      }
    } catch (_ignoreSessionGet) {}
    return "";
  }

  function makeHandle(provider) {
    return normalizeProvider(provider) + "-" + String(now()) + "-" + String(UUID.randomUUID()).substring(0, 8);
  }

  function runCommand(args, options) {
    var startedAt = now();
    var result = {
      command: args.join(" "),
      exitCode: -1,
      stdout: "",
      stderr: "",
      durationMs: 0,
      ok: false,
      error: ""
    };
    var outFile = null;
    var errFile = null;
    try {
      var pb = new ProcessBuilder(toJavaList(args));
      applyEngineProxyEnvironment(pb.environment(), options && options.proxyTargetUrl);
      if (options && options.cwd) {
        pb.directory(new File(String(options.cwd)));
      }
      if (options && options.env) {
        envObjectToMap(pb.environment(), options.env);
      }
      outFile = File.createTempFile("c8o-agent-bridge-out-", ".log");
      errFile = File.createTempFile("c8o-agent-bridge-err-", ".log");
      pb.redirectOutput(outFile);
      pb.redirectError(errFile);
      var process = pb.start();
      var finished = process.waitFor(options && options.timeoutMs ? options.timeoutMs : 15000, TimeUnit.MILLISECONDS);
      if (!finished) {
        process.destroyForcibly();
        try { process.waitFor(2, TimeUnit.SECONDS); } catch (_ignoreDestroyedWait) {}
        result.error = "timeout";
      }
      try {
        result.exitCode = process.exitValue();
      } catch (_ignoreExitValue) {
        result.exitCode = -1;
      }
      result.stdout = readTextFile(outFile);
      result.stderr = readTextFile(errFile);
      result.ok = finished && result.exitCode === 0;
    } catch (e) {
      result.error = String(e);
    } finally {
      try { if (outFile !== null) { Files.deleteIfExists(outFile.toPath()); } } catch (_ignoreCommandOutDelete) {}
      try { if (errFile !== null) { Files.deleteIfExists(errFile.toPath()); } } catch (_ignoreCommandErrDelete) {}
    }
    result.durationMs = now() - startedAt;
    return result;
  }

  function runCommandCaptured(args, options) {
    var startedAt = now();
    var result = {
      command: args.join(" "),
      exitCode: -1,
      stdout: "",
      stderr: "",
      durationMs: 0,
      ok: false,
      error: ""
    };
    var outFile = null;
    var errFile = null;
    try {
      outFile = File.createTempFile("c8o-agent-bridge-out-", ".log");
      errFile = File.createTempFile("c8o-agent-bridge-err-", ".log");
      var pb = new ProcessBuilder(toJavaList(args));
      applyEngineProxyEnvironment(pb.environment(), options && options.proxyTargetUrl);
      if (options && options.cwd) {
        pb.directory(new File(String(options.cwd)));
      }
      if (options && options.env) {
        envObjectToMap(pb.environment(), options.env);
      }
      pb.redirectOutput(outFile);
      pb.redirectError(errFile);
      var process = pb.start();
      var finished = process.waitFor(options && options.timeoutMs ? options.timeoutMs : 15000, TimeUnit.MILLISECONDS);
      if (!finished) {
        process.destroyForcibly();
        try { process.waitFor(2, TimeUnit.SECONDS); } catch (_ignoreCapturedDestroyedWait) {}
        result.error = "timeout";
      }
      try {
        result.exitCode = process.exitValue();
      } catch (_ignoreCapturedExitValue) {
        result.exitCode = -1;
      }
      result.stdout = readTextFile(outFile);
      result.stderr = readTextFile(errFile);
      result.ok = finished && result.exitCode === 0;
    } catch (e) {
      result.error = String(e);
    } finally {
      try { if (outFile !== null) { Files.deleteIfExists(outFile.toPath()); } } catch (_ignoreOutDelete) {}
      try { if (errFile !== null) { Files.deleteIfExists(errFile.toPath()); } } catch (_ignoreErrDelete) {}
    }
    result.durationMs = now() - startedAt;
    return result;
  }

  function compactCommandResult(result, maxChars) {
    result = result || {};
    var limit = intValue(maxChars, 4000, 256, 16000);
    var compactText = function (value) {
      var text = String(value || "");
      if (text.length <= limit) {
        return text;
      }
      return "... " + text.substring(text.length - limit);
    };
    return {
      command: String(result.command || ""),
      exitCode: typeof result.exitCode === "number" ? result.exitCode : -1,
      stdout: compactText(result.stdout),
      stderr: compactText(result.stderr),
      durationMs: Number(result.durationMs || 0),
      ok: result.ok === true,
      error: String(result.error || "")
    };
  }

  function requireSuccessfulCommand(result, label) {
    if (result && result.ok === true) {
      return result;
    }
    result = result || {};
    var detail = trim(result.stderr) || trim(result.error) || trim(result.stdout) || "unknown error";
    if (detail.length > 2000) {
      detail = "... " + detail.substring(detail.length - 2000);
    }
    var exitCode = typeof result.exitCode === "number" ? " (exit " + result.exitCode + ")" : "";
    throw new Error(String(label || "Command") + " failed" + exitCode + ": " + detail);
  }

  function parseJsonSafe(text, fallback) {
    try {
      return JSON.parse(String(text || ""));
    } catch (_ignoreJsonParse) {
      return fallback;
    }
  }

  function runProcessBuilder(pb, options) {
    var startedAt = now();
    var result = {
      command: String(pb.command()),
      exitCode: -1,
      stdout: "",
      stderr: "",
      durationMs: 0,
      ok: false,
      error: ""
    };
    var outFile = null;
    var errFile = null;
    try {
      applyEngineProxyEnvironment(pb.environment(), options && options.proxyTargetUrl);
      if (options && options.cwd) {
        pb.directory(new File(String(options.cwd)));
      }
      if (options && options.env) {
        envObjectToMap(pb.environment(), options.env);
      }
      outFile = File.createTempFile("c8o-agent-bridge-out-", ".log");
      errFile = File.createTempFile("c8o-agent-bridge-err-", ".log");
      pb.redirectOutput(outFile);
      pb.redirectError(errFile);
      var process = pb.start();
      var finished = process.waitFor(options && options.timeoutMs ? options.timeoutMs : 15000, TimeUnit.MILLISECONDS);
      if (!finished) {
        process.destroyForcibly();
        try { process.waitFor(2, TimeUnit.SECONDS); } catch (_ignoreProcessBuilderDestroyedWait) {}
        result.error = "timeout";
      }
      try {
        result.exitCode = process.exitValue();
      } catch (_ignoreProcessBuilderExitValue) {
        result.exitCode = -1;
      }
      result.stdout = readTextFile(outFile);
      result.stderr = readTextFile(errFile);
      result.ok = finished && result.exitCode === 0;
    } catch (e) {
      result.error = String(e);
    } finally {
      try { if (outFile !== null) { Files.deleteIfExists(outFile.toPath()); } } catch (_ignoreProcessBuilderOutDelete) {}
      try { if (errFile !== null) { Files.deleteIfExists(errFile.toPath()); } } catch (_ignoreProcessBuilderErrDelete) {}
    }
    result.durationMs = now() - startedAt;
    return result;
  }

  function copyStreamToFile(input, file) {
    var parent = file.getParentFile();
    if (parent !== null) {
      ensureDirectory(parent);
    }
    var out = new FileOutputStream(file);
    var total = 0;
    try {
      var buffer = java.lang.reflect.Array.newInstance(java.lang.Byte.TYPE, 1024 * 1024);
      var n;
      while ((n = input.read(buffer)) !== -1) {
        out.write(buffer, 0, n);
        total += n;
      }
    } finally {
      try { out.close(); } catch (_ignoreOutClose) {}
      try { input.close(); } catch (_ignoreInputClose) {}
    }
    return total;
  }

  function exceptionChain(error) {
    var messages = [];
    var current = error;
    try {
      if (error && error.javaException) {
        current = error.javaException;
      } else if (error && error.getWrappedException) {
        current = error.getWrappedException();
      }
    } catch (_ignoreWrappedException) {}
    for (var i = 0; current !== null && typeof current !== "undefined" && i < 8; i++) {
      var message = trim(String(current));
      if (message.length && messages.indexOf(message) === -1) {
        messages.push(message);
      }
      try {
        current = current.getCause ? current.getCause() : null;
      } catch (_ignoreExceptionCause) {
        current = null;
      }
    }
    return messages.join(" caused by ") || String(error);
  }

  function resolveRedirectUrl(baseUrl, location) {
    return String(new Packages.java.net.URI(String(baseUrl)).resolve(String(location)).toString());
  }

  function redirectLocationValue(header) {
    if (header === null || typeof header === "undefined") {
      return "";
    }
    if (typeof header.getValue === "function") {
      return String(header.getValue());
    }
    return String(header).replace(/^Location\s*:\s*/i, "");
  }

  function validateAbsoluteHttpUrl(url) {
    var uri = new Packages.java.net.URI(String(url));
    var scheme = trim(uri.getScheme()).toLowerCase();
    var host = trim(uri.getHost());
    if ((scheme !== "http" && scheme !== "https") || !host.length) {
      throw new Error("Invalid absolute HTTP URL: " + url);
    }
    return uri;
  }

  function downloadFile(url, file) {
    var startedAt = now();
    var result = {
      url: String(url),
      finalUrl: String(url),
      path: filePath(file),
      bytes: 0,
      durationMs: 0,
      ok: false,
      statusCode: 0,
      redirects: 0,
      error: ""
    };
    try {
      var currentUrl = String(url);
      var maxRedirects = 8;
      while (true) {
        var get = new Packages.org.apache.http.client.methods.HttpGet(currentUrl);
        get.setHeader("User-Agent", "lib_ConvertigoAgentBridge");
        get.setHeader("Accept", "application/octet-stream");
        var requestConfig = Packages.org.apache.http.client.config.RequestConfig.custom().setRedirectsEnabled(false);
        configureHttpRequestProxy(get, requestConfig, currentUrl);
        get.setConfig(requestConfig.build());
        validateAbsoluteHttpUrl(currentUrl);
        var response = Packages.com.twinsoft.convertigo.engine.Engine.theApp.httpClient4.execute(get);
        try {
          result.statusCode = response.getStatusLine().getStatusCode();
          result.finalUrl = currentUrl;
          if (result.statusCode >= 300 && result.statusCode < 400) {
            var location = response.getFirstHeader("Location");
            if (location === null) {
              throw new Error("HTTP " + result.statusCode + " without Location while downloading " + currentUrl);
            }
            result.redirects++;
            if (result.redirects > maxRedirects) {
              throw new Error("Too many redirects while downloading " + url);
            }
            currentUrl = resolveRedirectUrl(currentUrl, redirectLocationValue(location));
            continue;
          }
          if (result.statusCode < 200 || result.statusCode >= 300) {
            throw new Error("HTTP " + result.statusCode + " while downloading " + currentUrl);
          }
          result.bytes = copyStreamToFile(response.getEntity().getContent(), file);
          result.ok = true;
          break;
        } finally {
          try { response.close(); } catch (_ignoreResponseClose) {}
        }
      }
    } catch (e) {
      result.error = exceptionChain(e);
    }
    result.durationMs = now() - startedAt;
    return result;
  }

  function sha256File(file) {
    var digest = MessageDigest.getInstance("SHA-256");
    var input = Files.newInputStream(file.toPath());
    try {
      var buffer = java.lang.reflect.Array.newInstance(java.lang.Byte.TYPE, 1024 * 1024);
      var n;
      while ((n = input.read(buffer)) !== -1) {
        digest.update(buffer, 0, n);
      }
    } finally {
      try { input.close(); } catch (_ignoreDigestClose) {}
    }
    var bytes = digest.digest();
    var out = [];
    for (var i = 0; i < bytes.length; i++) {
      var value = bytes[i];
      if (value < 0) {
        value += 256;
      }
      var hex = value.toString(16);
      if (hex.length < 2) {
        hex = "0" + hex;
      }
      out.push(hex);
    }
    return out.join("");
  }

  function acquireFileLock(file, timeoutMs) {
    var startedAt = now();
    var parent = file.getParentFile();
    if (parent !== null) {
      ensureDirectory(parent);
    }
    var raf = new RandomAccessFile(file, "rw");
    var channel = raf.getChannel();
    while (true) {
      var lock = null;
      try {
        lock = channel.tryLock();
      } catch (_ignoreLockBusy) {}
      if (lock !== null) {
        return {
          path: filePath(file),
          release: function () {
            try { lock.release(); } catch (_ignoreLockRelease) {}
            try { channel.close(); } catch (_ignoreChannelClose) {}
            try { raf.close(); } catch (_ignoreRafClose) {}
          }
        };
      }
      if (now() - startedAt > timeoutMs) {
        try { channel.close(); } catch (_ignoreChannelCloseTimeout) {}
        try { raf.close(); } catch (_ignoreRafCloseTimeout) {}
        throw new Error("Timeout while waiting for install lock: " + filePath(file));
      }
      Thread.sleep(250);
    }
  }

  function pythonPlatformTag() {
    var os = String(System.getProperty("os.name") || "").toLowerCase();
    var arch = String(System.getProperty("os.arch") || "").toLowerCase();
    if (arch === "amd64") {
      arch = "x86_64";
    } else if (arch === "arm64") {
      arch = "aarch64";
    }
    if (os.indexOf("win") >= 0) {
      return arch + "-pc-windows-msvc";
    }
    if (os.indexOf("mac") >= 0 || os.indexOf("darwin") >= 0) {
      return arch + "-apple-darwin";
    }
    if (os.indexOf("linux") >= 0) {
      return arch + "-unknown-linux-gnu";
    }
    return arch + "-unknown-" + os.replace(/[^a-z0-9]+/g, "-");
  }

  function pythonRuntimeSpec(options, workspaceRoot) {
    options = options || {};
    var version = trim(options.pythonVersion) || DEFAULT_PYTHON_VERSION;
    var buildTag = trim(options.pythonBuildTag || options.pythonBuild) || DEFAULT_PYTHON_BUILD_TAG;
    var platform = trim(options.pythonPlatform) || pythonPlatformTag();
    var flavor = trim(options.pythonArchiveFlavor) || DEFAULT_PYTHON_ARCHIVE_FLAVOR;
    var runtimeId = "cpython-" + version + "-" + buildTag + "-" + platform;
    var installDir = normalizeDirectory(options.pythonInstallDir, childPath(childPath(childPath(workspaceRoot, "agents"), "runtimes/python"), runtimeId), workspaceRoot);
    var asset = "cpython-" + version + "+" + buildTag + "-" + platform + "-" + flavor + ".tar.gz";
    var archiveUrl = trim(options.pythonArchiveUrl);
    if (!archiveUrl.length) {
      // Convertigo request variables are Java String objects in Rhino. An empty
      // Java string is truthy, so normalize candidates before choosing one.
      var prefix = firstNonBlank([
        options.pythonAssetUrlPrefix,
        options.pythonMirrorBaseUrl,
        DEFAULT_PYTHON_ASSET_PREFIX
      ]);
      prefix = prefix.replace(/\{tag\}/g, buildTag);
      archiveUrl = prefix.replace(/\/+$/g, "") + "/" + asset.replace(/\+/g, "%2B");
    }
    return {
      version: version,
      buildTag: buildTag,
      platform: platform,
      flavor: flavor,
      id: runtimeId,
      installDir: installDir,
      archiveUrl: archiveUrl,
      archiveName: asset,
      lockFile: childPath(childPath(workspaceRoot, "agents/runtimes/python"), runtimeId + ".lock")
    };
  }

  function pythonBinaryCandidates(runtimeDir) {
    return [
      childPath(childPath(runtimeDir, "python/bin"), "python3"),
      childPath(childPath(runtimeDir, "python/bin"), "python"),
      childPath(childPath(runtimeDir, "python"), "python.exe"),
      childPath(childPath(runtimeDir, "bin"), "python3"),
      childPath(childPath(runtimeDir, "bin"), "python"),
      childPath(runtimeDir, "python.exe")
    ];
  }

  function detectPythonRuntime(options, localPython) {
    options = options || {};
    var workspaceRoot = resolveWorkspaceRoot(options);
    var runtime = pythonRuntimeSpec(options, workspaceRoot);
    var userHome = String(System.getProperty("user.home"));
    var homeLocalBin = childPath(userHome, ".local/bin");
    var pythonEnv = "";
    try {
      pythonEnv = String(System.getenv("PYTHON") || "");
    } catch (_ignorePythonEnv) {}
    var candidates = [
      trim(options.pythonPath || options.commandPath),
      pythonEnv,
      trim(localPython)
    ].concat(pythonBinaryCandidates(runtime.installDir), [
      childPath(homeLocalBin, "python3"),
      "/opt/homebrew/bin/python3",
      "/usr/local/bin/python3",
      "python3",
      "python"
    ]);
    return {
      workspaceRoot: workspaceRoot,
      runtime: runtime,
      command: firstWorkingCommand(candidates, ["--version"])
    };
  }

  function ensurePythonRuntime(options) {
    options = options || {};
    var detected = detectPythonRuntime(options, "");
    var runtime = detected.runtime;
    var forceOption = typeof options.force !== "undefined" ? options.force : options.forcePythonInstall;
    var force = boolValue(forceOption, false);
    var workspaceFirstOption = typeof options.workspaceInstallFirst !== "undefined" ? options.workspaceInstallFirst : options.preferWorkspaceInstall;
    var workspaceFirst = boolValue(typeof workspaceFirstOption === "undefined" ? true : workspaceFirstOption, true);
    var managedPythonReady = detected.command.found && commandPathStartsWith(detected.command, runtime.installDir);
    if (detected.command.found && !force && (!workspaceFirst || managedPythonReady)) {
      return {
        attempted: false,
        installed: false,
        reused: true,
        runtime: runtime,
        python: detected.command,
        steps: [],
        timestamp: now()
      };
    }
    var allowDownloadOption = typeof options.allowDownload !== "undefined" ? options.allowDownload : options.allowPythonDownload;
    var allowDownload = boolValue(allowDownloadOption, true);
    if (!allowDownload) {
      throw new Error(workspaceFirst ? "Managed Python is missing and downloads are disabled" : "Python is missing and downloads are disabled");
    }

    var lock = acquireFileLock(new File(runtime.lockFile), intValue(options.pythonInstallLockTimeoutMs, 600000, 10000, 3600000));
    var steps = [];
    try {
      detected = detectPythonRuntime(options, "");
      managedPythonReady = detected.command.found && commandPathStartsWith(detected.command, runtime.installDir);
      if (detected.command.found && !force && (!workspaceFirst || managedPythonReady)) {
        return {
          attempted: true,
          installed: false,
          reused: true,
          runtime: runtime,
          python: detected.command,
          steps: steps,
          timestamp: now()
        };
      }
      var target = new File(runtime.installDir);
      ensureDirectory(target);
      var archiveFile = new File(target.getParentFile(), runtime.archiveName);
      var download = downloadFile(runtime.archiveUrl, archiveFile);
      steps.push({ action: "download", result: download });
      if (!download.ok) {
        throw new Error(download.error || ("Unable to download " + runtime.archiveUrl));
      }
      var expectedSha256 = trim(options.pythonArchiveSha256 || options.pythonSha256);
      if (expectedSha256.length) {
        var actualSha256 = sha256File(archiveFile);
        steps.push({ action: "sha256", expected: expectedSha256, actual: actualSha256, ok: expectedSha256.toLowerCase() === actualSha256.toLowerCase() });
        if (expectedSha256.toLowerCase() !== actualSha256.toLowerCase()) {
          throw new Error("Python archive checksum mismatch");
        }
      }
      steps.push({ action: "extract", result: runCommand(["tar", "-xzf", filePath(archiveFile), "-C", filePath(target)], { timeoutMs: intValue(options.pythonExtractTimeoutMs, 300000, 30000, 1800000) }) });
      if (!steps[steps.length - 1].result.ok) {
        throw new Error("Unable to extract Python archive: " + (steps[steps.length - 1].result.stderr || steps[steps.length - 1].result.error));
      }
      try { Files.deleteIfExists(archiveFile.toPath()); } catch (_ignoreArchiveDelete) {}
      var managedPython = firstWorkingCommand(pythonBinaryCandidates(runtime.installDir), ["--version"]);
      if (!managedPython.found) {
        throw new Error("Python archive was extracted but no runnable python executable was found");
      }
      return {
        attempted: true,
        installed: true,
        reused: false,
        runtime: runtime,
        python: managedPython,
        steps: steps,
        timestamp: now()
      };
    } finally {
      lock.release();
    }
  }

  function executableName(name) {
    var value = String(name || "");
    if (isWindows() && value.indexOf(".") < 0) {
      return value + ".exe";
    }
    return value;
  }

  function scriptCommandName(name) {
    var value = String(name || "");
    if (isWindows() && value.indexOf(".") < 0) {
      return value + ".cmd";
    }
    return value;
  }

  function detectNpmRuntime(options) {
    options = options || {};
    var workspaceRoot = resolveWorkspaceRoot(options);
    var nodeVersion = trim(options.nodeVersion) || String(ProcessUtils.getDefaultNodeVersion());
    var userHome = String(System.getProperty("user.home"));
    var localNodeDir = normalizeDirectory(options.nodeDir || options.nodeInstallDir, filePath(ProcessUtils.getDefaultNodeDir()), workspaceRoot);
    var npmName = scriptCommandName("npm");
    var candidates = [
      trim(options.npmPath),
      childPath(localNodeDir, npmName),
      childPath(childPath(localNodeDir, "bin"), npmName),
      childPath(childPath(userHome, ".local/bin"), npmName),
      "/opt/homebrew/bin/npm",
      "/usr/local/bin/npm",
      "npm"
    ];
    return {
      workspaceRoot: workspaceRoot,
      nodeVersion: nodeVersion,
      nodeDir: localNodeDir,
      npm: firstWorkingCommand(candidates, ["--version"])
    };
  }

  function detectNodeRuntime(options) {
    options = options || {};
    var workspaceRoot = resolveWorkspaceRoot(options);
    var userHome = String(System.getProperty("user.home"));
    var localNodeDir = normalizeDirectory(options.nodeDir || options.nodeInstallDir, filePath(ProcessUtils.getDefaultNodeDir()), workspaceRoot);
    var nodeName = executableName("node");
    var candidates = [
      trim(options.nodePath || options.nodeCommand || options.nodeExecutable),
      childPath(localNodeDir, nodeName),
      childPath(childPath(localNodeDir, "bin"), nodeName)
    ];
    try {
      var defaultNodeDir = filePath(ProcessUtils.getDefaultNodeDir());
      candidates.push(childPath(defaultNodeDir, nodeName));
      candidates.push(childPath(childPath(defaultNodeDir, "bin"), nodeName));
    } catch (_ignoreDefaultNodeCandidate) {}
    try {
      var npmRuntime = detectNpmRuntime(options);
      if (npmRuntime.npm && npmRuntime.npm.found) {
        var npmParent = parentPath(npmRuntime.npm.path);
        if (npmParent.length) {
          candidates.push(childPath(npmParent, nodeName));
          candidates.push(childPath(parentPath(npmParent), nodeName));
        }
      }
    } catch (_ignoreNpmNodeCandidate) {}
    candidates.push(childPath(childPath(userHome, ".local"), "bin/" + nodeName));
    candidates.push("/opt/homebrew/bin/" + nodeName);
    candidates.push("/usr/local/bin/" + nodeName);
    candidates.push("node");
    return firstWorkingCommand(candidates, ["--version"], nodeRuntimeSearchPath(options));
  }

  function ensureNpmRuntime(options) {
    options = options || {};
    var detected = detectNpmRuntime(options);
    if (detected.npm.found) {
      return {
        attempted: false,
        installedNode: false,
        reused: true,
        nodeVersion: detected.nodeVersion,
        nodeDir: detected.nodeDir,
        npm: detected.npm,
        steps: [],
        timestamp: now()
      };
    }
    var allowDownloadOption = typeof options.allowNodeDownload !== "undefined" ? options.allowNodeDownload : true;
    if (!boolValue(allowDownloadOption, true)) {
      throw new Error("npm is missing and Node.js downloads are disabled");
    }
    var nodeVersion = trim(options.nodeVersion) || String(ProcessUtils.getDefaultNodeVersion());
    var nodeDir = ProcessUtils.getNodeDir(nodeVersion);
    var nodeDirPath = filePath(nodeDir);
    var npm = firstWorkingCommand([
      childPath(nodeDirPath, scriptCommandName("npm")),
      childPath(childPath(nodeDirPath, "bin"), scriptCommandName("npm"))
    ], ["--version"]);
    if (!npm.found) {
      throw new Error("Node.js was installed but npm was not found in " + nodeDirPath);
    }
    return {
      attempted: true,
      installedNode: true,
      reused: false,
      nodeVersion: nodeVersion,
      nodeDir: nodeDirPath,
      npm: npm,
      steps: [{ action: "node_install", nodeVersion: nodeVersion, nodeDir: nodeDirPath }],
      timestamp: now()
    };
  }

  function codexLocalBin(installDir) {
    return childPath(childPath(childPath(installDir, "npm"), "node_modules/.bin"), scriptCommandName("codex"));
  }

  function codexNpmPrefix(installDir) {
    return childPath(installDir, "npm");
  }

  function codexNodeModulesPath(installDir) {
    return childPath(codexNpmPrefix(installDir), "node_modules");
  }

  function codexPackageSpec(options) {
    var name = trim(options.codexPackage || options.packageName) || "@openai/codex";
    var version = trim(options.codexVersion || options.packageVersion || options.version) || "latest";
    if (!version.length) {
      return name;
    }
    return name + "@" + version;
  }

  function codexPlaywrightEnv(options, installDir) {
    var env = {};
    var path = nodeRuntimeSearchPath(options || {});
    if (path.length) {
      env.PATH = path + String(File.pathSeparator) + String(System.getenv("PATH") || "");
    }
    env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
    return env;
  }

  function detectCodexPlaywrightRuntime(options, installDir) {
    options = options || {};
    var packageSpec = codexPlaywrightMcpPackageSpec(options);
    var packageName = npmPackageNameFromSpec(packageSpec);
    var nodeModules = codexNodeModulesPath(installDir);
    var packagePath = childPath(childPath(nodeModules, packageName), "package.json");
    var binPath = childPath(childPath(nodeModules, ".bin"), codexPlaywrightMcpBinaryName(options));
    var node = detectNodeRuntime(options);
    var npx = detectNpxRuntime(options);
    var runtime = {
      found: false,
      package: packageName,
      packageSpec: packageSpec,
      packagePath: packagePath,
      packageExists: new File(packagePath).exists(),
      binPath: binPath,
      binExists: new File(binPath).exists(),
      nodeModules: nodeModules,
      version: "",
      node: node,
      npx: npx,
      probe: {
        checked: false,
        ok: false,
        stdout: "",
        stderr: "",
        error: ""
      },
      env: {
        nodePath: nodeModules,
        skipBrowserDownload: true
      }
    };
    if (!runtime.packageExists) {
      runtime.probe.error = packageName + " is not installed";
      return runtime;
    }
    try {
      var packageJson = JSON.parse(readTextFile(new File(packagePath)));
      runtime.version = trim(packageJson.version);
    } catch (_ignorePlaywrightMcpPackageJson) {}
    if (!npx.found) {
      runtime.probe.error = "npx is not available";
      return runtime;
    }
    if (!node.found) {
      runtime.probe.error = "node is not available";
      return runtime;
    }
    var probe = runCommand([npx.path, "--prefix", codexNpmPrefix(installDir), codexPlaywrightMcpBinaryName(options), "--version"], {
      timeoutMs: 15000,
      env: codexPlaywrightEnv(options, installDir)
    });
    runtime.probe.checked = true;
    runtime.probe.ok = probe.ok;
    runtime.probe.stdout = probe.stdout;
    runtime.probe.stderr = probe.stderr;
    runtime.probe.error = probe.error;
    runtime.found = probe.ok;
    if (!runtime.version.length) {
      runtime.version = trim((probe.stdout || "") + "\n" + (probe.stderr || "")).replace(/^Version\s+/i, "").split(/\r?\n/)[0] || "";
    }
    return runtime;
  }

  function ensureCodexPlaywrightRuntime(options, installDir) {
    options = options || {};
    var before = detectCodexPlaywrightRuntime(options, installDir);
    if (boolValue(options.skipCodexPlaywrightInstall || options.skipPlaywrightInstall, false)) {
      return {
        attempted: false,
        installed: false,
        reused: before.found,
        skipped: true,
        method: "skipped",
        package: "",
        before: before,
        playwright: before,
        steps: [],
        timestamp: now()
      };
    }
    var force = boolValue(options.forceCodexPlaywrightInstall || options.forcePlaywrightInstall, false);
    if (before.found && !force) {
      return {
        attempted: false,
        installed: false,
        reused: true,
        skipped: false,
        method: "existing",
        package: "",
        before: before,
        playwright: before,
        steps: [],
        timestamp: now()
      };
    }
    var npmPrefix = codexNpmPrefix(installDir);
    ensureDirectory(new File(npmPrefix));
    var npmRuntime = ensureNpmRuntime(options);
    var packageSpec = codexPlaywrightMcpPackageSpec(options);
    var installEnv = {
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1"
    };
    var install = runNpmInstall(npmRuntime.npm, packageSpec, npmPrefix, options, installEnv);
    var steps = [{ action: "npm_install", package: packageSpec, prefix: npmPrefix, env: installEnv, result: install }];
    if (!install.ok) {
      throw new Error("Unable to install Playwright MCP for Codex with npm: " + (install.stderr || install.stdout || install.error));
    }
    var after = detectCodexPlaywrightRuntime(options, installDir);
    if (!after.found) {
      throw new Error("Playwright MCP package was installed but cannot be executed from " + codexNodeModulesPath(installDir));
    }
    return {
      attempted: true,
      installed: true,
      reused: false,
      skipped: false,
      method: "npm",
      package: packageSpec,
      npm: npmRuntime,
      before: before,
      playwright: after,
      steps: steps,
      timestamp: now()
    };
  }

  function runNpmInstall(npm, packageSpec, prefixDir, options, extraEnv) {
    var startedAt = now();
    try {
      log.info("Agent Bridge npm installation started: " + packageSpec);
    } catch (_ignoreNpmInstallStartLog) {}
    var result = runNpmCommand(npm, ["install", "--no-audit", "--no-fund", "--prefix", prefixDir, packageSpec], {
      cwd: prefixDir,
      env: extraEnv || null,
      timeoutMs: intValue(options.codexInstallTimeoutMs || options.npmInstallTimeoutMs, 600000, 30000, 1800000)
    });
    try {
      log.info("Agent Bridge npm installation " + (result.ok ? "completed" : "failed") + ": " + packageSpec + " (" + (now() - startedAt) + " ms)");
    } catch (_ignoreNpmInstallEndLog) {}
    return result;
  }

  function runNpmCommand(npm, args, options) {
    var npmDir = parentPath(npm.path);
    var paths = npmDir.length ? npmDir : "";
    var normalizedNpmDir = npmDir.replace(/\\/g, "/");
    var npmMarker = "/lib/node_modules/npm/bin";
    var markerIndex = normalizedNpmDir.indexOf(npmMarker);
    if (markerIndex > 0) {
      var nodeBinDir = normalizedNpmDir.substring(0, markerIndex) + "/bin";
      paths = nodeBinDir + (paths.length ? String(File.pathSeparator) + paths : "");
    }
    var commandArgs = ["npm"];
    for (var i = 0; i < args.length; i++) {
      commandArgs.push(String(args[i]));
    }
    var command = toJavaList(commandArgs);
    var pb = ProcessUtils.getNpmProcessBuilder(paths, command);
    return runProcessBuilder(pb, {
      cwd: options && options.cwd ? options.cwd : null,
      env: options && options.env ? options.env : null,
      proxyTargetUrl: "https://registry.npmjs.org",
      timeoutMs: options && options.timeoutMs ? options.timeoutMs : 15000
    });
  }

  function ensureCodexRuntime(options) {
    options = options || {};
    var before = detectCodexRuntime(options);
    var force = boolValue(options.forceCodexInstall || options.forceInstall || options.force, false);
    var workspaceFirstOption = typeof options.workspaceInstallFirst !== "undefined" ? options.workspaceInstallFirst : options.preferWorkspaceInstall;
    var workspaceFirst = boolValue(typeof workspaceFirstOption === "undefined" ? true : workspaceFirstOption, true);
    if (before.codex.found && !force && (!workspaceFirst || commandPathStartsWith(before.codex, before.installDir))) {
      var existingPlaywright = commandPathStartsWith(before.codex, before.installDir) ? ensureCodexPlaywrightRuntime(options, before.installDir) : {
        attempted: false,
        installed: false,
        reused: false,
        skipped: true,
        method: "external_codex",
        package: "",
        before: detectCodexPlaywrightRuntime(options, before.installDir),
        playwright: detectCodexPlaywrightRuntime(options, before.installDir),
        steps: [],
        timestamp: now()
      };
      return {
        attempted: false,
        installed: false,
        reused: true,
        method: "existing",
        package: "",
        npm: null,
        before: before.codex,
        codex: before.codex,
        playwright: existingPlaywright,
        steps: [],
        timestamp: now()
      };
    }
    var method = trim(options.codexInstallMethod || options.installMethod) || "npm";
    if (method !== "npm") {
      throw new Error("Unsupported Codex install method: " + method);
    }
    var lock = acquireFileLock(new File(childPath(before.installDir, "codex-install.lock")), intValue(options.codexInstallLockTimeoutMs, 600000, 10000, 3600000));
    var steps = [];
    try {
      before = detectCodexRuntime(options);
      if (before.codex.found && !force && (!workspaceFirst || commandPathStartsWith(before.codex, before.installDir))) {
        var lockedPlaywright = commandPathStartsWith(before.codex, before.installDir) ? ensureCodexPlaywrightRuntime(options, before.installDir) : {
          attempted: false,
          installed: false,
          reused: false,
          skipped: true,
          method: "external_codex",
          package: "",
          before: detectCodexPlaywrightRuntime(options, before.installDir),
          playwright: detectCodexPlaywrightRuntime(options, before.installDir),
          steps: [],
          timestamp: now()
        };
        return {
          attempted: true,
          installed: false,
          reused: true,
          method: "existing",
          package: "",
          npm: null,
          before: before.codex,
          codex: before.codex,
          playwright: lockedPlaywright,
          steps: steps,
          timestamp: now()
        };
      }
      var fallbackCodex = before.codex.found && !commandPathStartsWith(before.codex, before.installDir) ? before.codex : null;
      try {
        ensureDirectory(new File(before.installDir));
        var npmPrefix = codexNpmPrefix(before.installDir);
        ensureDirectory(new File(npmPrefix));
        var npmRuntime = ensureNpmRuntime(options);
        var packageSpec = codexPackageSpec(options);
        var install = runNpmInstall(npmRuntime.npm, packageSpec, npmPrefix, options);
        steps.push({ action: "npm_install", package: packageSpec, prefix: npmPrefix, result: install });
        if (!install.ok) {
          throw new Error("Unable to install Codex CLI with npm: " + (install.stderr || install.stdout || install.error));
        }
        var afterOptions = {};
        for (var key in options) {
          if (Object.prototype.hasOwnProperty.call(options, key)) {
            afterOptions[key] = options[key];
          }
        }
        afterOptions.codexPath = codexLocalBin(before.installDir);
        var after = detectCodexRuntime(afterOptions);
        if (!after.codex.found) {
          throw new Error("Codex CLI package was installed but no runnable codex executable was found");
        }
        var playwright = ensureCodexPlaywrightRuntime(options, before.installDir);
        return {
          attempted: true,
          installed: true,
          reused: false,
          method: "npm",
          package: packageSpec,
          npm: npmRuntime,
          before: before.codex,
          codex: after.codex,
          codexPath: after.codex.path,
          playwright: playwright,
          steps: steps,
          timestamp: now()
        };
      } catch (installError) {
        if (workspaceFirst && fallbackCodex !== null && !force) {
          return {
            attempted: true,
            installed: false,
            reused: true,
            method: "workspace_install_failed_user_fallback",
            package: codexPackageSpec(options),
            npm: null,
            before: before.codex,
            codex: fallbackCodex,
            codexPath: fallbackCodex.path,
            playwright: {
              attempted: false,
              installed: false,
              reused: false,
              skipped: true,
              method: "workspace_install_failed_user_fallback",
              package: "",
              before: detectCodexPlaywrightRuntime(options, before.installDir),
              playwright: detectCodexPlaywrightRuntime(options, before.installDir),
              steps: [],
              timestamp: now()
            },
            steps: steps,
            error: String(installError),
            timestamp: now()
          };
        }
        throw installError;
      }
    } finally {
      lock.release();
    }
  }

  function firstWorkingCommand(candidates, versionArgs, extraPath) {
    var attempts = [];
    for (var i = 0; i < candidates.length; i++) {
      var candidate = trim(candidates[i]);
      if (!candidate.length) {
        continue;
      }
      var args = [candidate].concat(versionArgs || ["--version"]);
      var env = {};
      var candidateParent = "";
      try {
        candidateParent = parentPath(candidate);
      } catch (_ignoreCandidateParent) {}
      var pathPrefix = "";
      if (candidateParent.length) {
        pathPrefix = candidateParent;
        var npmMarker = "/lib/node_modules/npm/bin";
        var normalizedParent = candidateParent.replace(/\\/g, "/");
        var markerIndex = normalizedParent.indexOf(npmMarker);
        if (markerIndex > 0) {
          pathPrefix = pathPrefix + String(File.pathSeparator) + normalizedParent.substring(0, markerIndex) + "/bin";
        }
      }
      if (trim(extraPath).length) {
        pathPrefix = pathPrefix.length ? pathPrefix + String(File.pathSeparator) + trim(extraPath) : trim(extraPath);
      }
      if (pathPrefix.length) {
        env.PATH = pathPrefix + String(File.pathSeparator) + String(System.getenv("PATH") || "");
      }
      var probe = runCommand(args, { timeoutMs: 10000, env: env });
      var versionText = trim((probe.stdout || "") + "\n" + (probe.stderr || ""));
      attempts.push({
        path: candidate,
        ok: probe.ok,
        exitCode: probe.exitCode,
        version: versionText.split(/\r?\n/)[0] || "",
        error: probe.error
      });
      if (probe.ok) {
        return {
          found: true,
          path: candidate,
          version: versionText.split(/\r?\n/)[0] || "",
          attempts: attempts
        };
      }
    }
    return {
      found: false,
      path: "",
      version: "",
      attempts: attempts
    };
  }

  function existingCommandFile(candidate) {
    var value = trim(candidate);
    if (!value.length) {
      return null;
    }
    var file = new File(value);
    if (file.isFile()) {
      return file;
    }
    if (!isWindows() || /\.[A-Za-z0-9]+$/.test(value)) {
      return null;
    }
    var extensions = [".exe", ".cmd", ".bat"];
    for (var i = 0; i < extensions.length; i++) {
      file = new File(value + extensions[i]);
      if (file.isFile()) {
        return file;
      }
    }
    return null;
  }

  function firstExistingCommand(candidates, extraPath) {
    var search = [];
    var seen = {};
    var add = function (value) {
      var candidate = trim(value);
      if (candidate.length && !seen[candidate]) {
        seen[candidate] = true;
        search.push(candidate);
      }
    };
    candidates = candidates || [];
    for (var i = 0; i < candidates.length; i++) {
      var candidate = trim(candidates[i]);
      if (!candidate.length) {
        continue;
      }
      if (candidate.indexOf("/") >= 0 || candidate.indexOf("\\") >= 0 || new File(candidate).isAbsolute()) {
        add(candidate);
        continue;
      }
      var pathValue = trim(extraPath);
      var systemPath = String(System.getenv("PATH") || "");
      pathValue = pathValue.length ? pathValue + String(File.pathSeparator) + systemPath : systemPath;
      var directories = pathValue.split(String(File.pathSeparator));
      for (var p = 0; p < directories.length; p++) {
        if (trim(directories[p]).length) {
          add(childPath(directories[p], candidate));
        }
      }
    }
    for (var j = 0; j < search.length; j++) {
      var file = existingCommandFile(search[j]);
      if (file !== null) {
        return {
          found: true,
          path: filePath(file),
          version: "",
          attempts: []
        };
      }
    }
    return {
      found: false,
      path: "",
      version: "",
      attempts: []
    };
  }

  function installedNpmPackageVersion(installDir, packageName) {
    try {
      var packageFile = new File(childPath(childPath(codexNodeModulesPath(installDir), packageName), "package.json"));
      var descriptor = readJsonFile(packageFile);
      return descriptor && descriptor.version ? extractRuntimeVersion(descriptor.version) : "";
    } catch (_ignoreInstalledNpmPackageVersion) {
      return "";
    }
  }

  function pythonDistInfoVersion(directoryName, packageName) {
    var normalizedDirectory = trim(directoryName).toLowerCase().replace(/-/g, "_");
    var normalizedPackage = trim(packageName).toLowerCase().replace(/-/g, "_");
    var prefix = normalizedPackage + "_";
    var suffix = ".dist_info";
    if (normalizedDirectory.indexOf(prefix) !== 0 || normalizedDirectory.slice(-suffix.length) !== suffix) {
      return "";
    }
    return extractRuntimeVersion(normalizedDirectory.substring(prefix.length, normalizedDirectory.length - suffix.length));
  }

  function installedPythonPackageVersion(venvDir, packageName) {
    try {
      var roots = [new File(childPath(childPath(venvDir, "Lib"), "site-packages"))];
      var libDir = new File(childPath(venvDir, "lib"));
      var pythonDirs = libDir.isDirectory() ? libDir.listFiles() : null;
      for (var i = 0; pythonDirs !== null && i < pythonDirs.length; i++) {
        if (pythonDirs[i].isDirectory() && String(pythonDirs[i].getName()).indexOf("python") === 0) {
          roots.push(new File(pythonDirs[i], "site-packages"));
        }
      }
      for (var rootIndex = 0; rootIndex < roots.length; rootIndex++) {
        var entries = roots[rootIndex].isDirectory() ? roots[rootIndex].listFiles() : null;
        for (var entryIndex = 0; entries !== null && entryIndex < entries.length; entryIndex++) {
          if (!entries[entryIndex].isDirectory()) {
            continue;
          }
          var version = pythonDistInfoVersion(entries[entryIndex].getName(), packageName);
          if (version.length) {
            return version;
          }
        }
      }
    } catch (_ignoreInstalledPythonPackageVersion) {}
    return "";
  }

  function inspectVibeConfig(file) {
    var info = {
      path: filePath(file),
      exists: file.exists(),
      hasMcpServers: false,
      hasConvertigoServer: false,
      hasHttpTransport: false,
      bearerTokenEnv: "",
      endpoint: "",
      gatewayUrl: "",
      gatewayModels: "",
      revealMode: false,
      noLog: false,
      valid: false
    };
    if (!info.exists) {
      return info;
    }
    var text = readTextFile(file);
    info.hasMcpServers = text.indexOf("[[mcp_servers]]") >= 0;
    var blockPattern = /\[\[mcp_servers\]\]([\s\S]*?)(?=\n\[\[mcp_servers\]\]|$)/g;
    var blockMatch;
    while ((blockMatch = blockPattern.exec(text)) !== null) {
      var block = blockMatch[1];
      var isConvertigo = /name\s*=\s*["']Convertigo["']|name\s*=\s*["']convertigo["']/.test(block);
      if (!isConvertigo) {
        continue;
      }
      info.hasConvertigoServer = true;
      info.hasHttpTransport = /transport\s*=\s*["']http["']/.test(block);
      var match = block.match(/url\s*=\s*["']([^"']+)["']/);
      info.endpoint = match ? match[1] : "";
      var bearerMatch = block.match(/api_key_env\s*=\s*["']([^"']+)["']/);
      info.bearerTokenEnv = bearerMatch ? bearerMatch[1] : "";
      var viewerPortMatch = block.match(/["']X-Convertigo-Viewer-Debug-Port["']\s*=\s*["'](\d+)["']/);
      info.viewerDebugPort = viewerPortMatch ? Number(viewerPortMatch[1]) : 0;
      info.revealMode = /["']X-Convertigo-Reveal-Mode["']\s*=\s*["']true["']/.test(block);
      info.noLog = /["']X-Convertigo-No-Log["']\s*=\s*["']true["']/.test(block);
      break;
    }
    info.gatewayUrl = parseVibeGatewayUrl(text);
    info.gatewayModels = parseVibeGatewayModels(text);
    info.playwrightEndpoint = "";
    info.playwrightCommand = "";
    var playwrightPattern = /\[\[mcp_servers\]\]([\s\S]*?)(?=\n\[\[mcp_servers\]\]|$)/g;
    var playwrightMatch;
    while ((playwrightMatch = playwrightPattern.exec(text)) !== null) {
      var playwrightBlock = playwrightMatch[1];
      if (!/name\s*=\s*["']playwright["']/.test(playwrightBlock)) {
        continue;
      }
      var cdpMatch = playwrightBlock.match(/"--cdp-endpoint",\s*"([^"]+)"/);
      info.playwrightEndpoint = cdpMatch ? cdpMatch[1] : "";
      // Only the list form is considered valid; a legacy string command is reported
      // empty so the config gets rewritten.
      var commandMatch = playwrightBlock.match(/\ncommand\s*=\s*\[\s*"((?:[^"\\]|\\.)*)"/);
      info.playwrightCommand = commandMatch ? commandMatch[1].replace(/\\(.)/g, "$1") : "";
      break;
    }
    info.valid = info.hasMcpServers && info.hasConvertigoServer && info.hasHttpTransport && info.endpoint.length > 0;
    return info;
  }

  function tomlString(value) {
    return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  // GLM models routed by Mistral are not Vibe CLI defaults: the Bridge declares them in the
  // managed config.toml of the Vibe (personal Mistral account) profile. Newest first. `efforts`
  // are the reasoning_effort values Mistral accepts for the model.
  // `push: false` keeps a model known (its levels, its spec when a conversation still asks for
  // it) without declaring it in new homes. Existing config.toml files are left as they are.
  var MANAGED_VIBE_GLM_PRESETS = [
    { name: "zai-glm-5-3", alias: "glm-5-3", efforts: ["low", "high", "max"] },
    { name: "zai-glm-5-2", alias: "glm-5-2", efforts: ["low", "medium", "high", "max"], push: false }
  ];

  function managedVibeGlmPreset(value) {
    var lower = trim(value).toLowerCase();
    for (var i = 0; i < MANAGED_VIBE_GLM_PRESETS.length; i++) {
      if (lower === MANAGED_VIBE_GLM_PRESETS[i].name || lower === MANAGED_VIBE_GLM_PRESETS[i].alias) { return MANAGED_VIBE_GLM_PRESETS[i]; }
    }
    return null;
  }

  function managedVibeGlmPresetBlock(preset) {
    return '[[models]]\nname = "' + preset.name + '"\nprovider = "mistral"\nalias = "' + preset.alias + '"\ninput_price = 1.4\noutput_price = 4.4\nthinking = "high"\nsupports_images = ' + (VIBE_GLM_SUPPORTS_IMAGES ? 'true' : 'false') + '\n';
  }

  function vibeModelSpec(value) {
    var model = trim(value);
    var lower = model.toLowerCase();
    if (!model.length || lower === "default" || lower === "auto") {
      model = "vibe-thinking";
      lower = model;
    }
    if (lower === "vibe-thinking") {
      return {
        activeModel: "vibe-thinking",
        name: "mistral-vibe-cli-latest",
        alias: "vibe-thinking",
        thinking: "high",
        temperature: "1.0",
        inputPrice: "1.5",
        outputPrice: "7.5",
        supportsImages: true
      };
    }
    if (lower === "mistral-medium-3.5") {
      return {
        activeModel: "mistral-medium-3.5",
        name: "mistral-vibe-cli-latest",
        alias: "mistral-medium-3.5",
        thinking: "high",
        temperature: "1.0",
        inputPrice: "1.5",
        outputPrice: "7.5",
        supportsImages: true
      };
    }
    var glmPreset = managedVibeGlmPreset(lower);
    if (glmPreset !== null) {
      return {
        activeModel: glmPreset.alias,
        name: glmPreset.name,
        alias: glmPreset.alias,
        efforts: glmPreset.efforts,
        thinking: "high",
        temperature: "1.0",
        inputPrice: "1.4",
        outputPrice: "4.4",
        builtIn: false,
        supportsImages: VIBE_GLM_SUPPORTS_IMAGES
      };
    }
    return {
      activeModel: model,
      name: model,
      alias: model,
      thinking: "",
      temperature: "1.0",
      inputPrice: "0.0",
      outputPrice: "0.0"
    };
  }

  function migrateManagedVibeModelPresets(text) {
    var removed = [];
    var presentPresets = {};
    var userManagedGlm = false;
    if (parseVibeGatewayUrl(text).length) {
      // Convertigo gateway profile: the model catalog is the gateway's, not Mistral's.
      return { text: String(text || ""), removed: [], added: false, migratedActiveModel: false };
    }
    var result = String(text || "").replace(/(^|\n)\[\[models\]\]([\s\S]*?)(?=\n\[\[|\n\[|$)/g, function (match, prefix, block) {
      var name = parseTomlValue(block, "name");
      var alias = parseTomlValue(block, "alias");
      for (var presetIndex = 0; presetIndex < MANAGED_VIBE_GLM_PRESETS.length; presetIndex++) {
        var candidate = MANAGED_VIBE_GLM_PRESETS[presetIndex];
        if (name === candidate.name || alias === candidate.alias || alias === candidate.name) { presentPresets[candidate.name] = true; }
      }
      // A GLM entry with its own provider or alias belongs to the user: leave the file alone.
      if (/^zai-glm-/i.test(name) && (parseTomlValue(block, "provider") !== "mistral" || (managedVibeGlmPreset(alias) === null && alias !== name))) {
        userManagedGlm = true;
      }
      var managed = parseTomlValue(block, "name") === "zai-glm-5-2"
        && parseTomlValue(block, "alias") === "zai-glm-5-2"
        && parseTomlValue(block, "provider") === "mistral"
        && parseTomlValue(block, "input_price") === "1.4"
        && parseTomlValue(block, "output_price") === "4.4"
        && parseTomlValue(block, "thinking") === "high";
      if (!managed) {
        return match;
      }
      removed.push("zai-glm-5-2");
      return match.replace(/(alias\s*=\s*["'])zai-glm-5-2(["'])/, "$1glm-5-2$2");
    });
    var glmImagesLine = "supports_images = " + (VIBE_GLM_SUPPORTS_IMAGES ? "true" : "false");
    result = result.replace(/((?:^|\n)\[\[models\]\]\s*\nname\s*=\s*["']zai-glm-[0-9.-]+["'][\s\S]*?)(supports_images\s*=\s*(?:true|false))/g, function (match, head, current) {
      return current === glmImagesLine ? match : head + glmImagesLine;
    });
    var migratedActiveModel = false;
    if (removed.length && /^\s*active_model\s*=\s*["']zai-glm-5-2["']/m.test(result)) {
      result = result.replace(/^(\s*active_model\s*=\s*["'])zai-glm-5-2(["'])/m, "$1glm-5-2$2");
      migratedActiveModel = true;
    }
    // GLM can be account-routed, but is not a guaranteed CLI default: declare every preset that
    // the config does not have yet, so a new GLM release reaches existing homes too.
    var addedPresets = [];
    for (var addIndex = 0; addIndex < MANAGED_VIBE_GLM_PRESETS.length; addIndex++) {
      var preset = MANAGED_VIBE_GLM_PRESETS[addIndex];
      if (!userManagedGlm && preset.push !== false && !presentPresets[preset.name]) {
        result = result.replace(/\s*$/, "") + "\n\n" + managedVibeGlmPresetBlock(preset);
        addedPresets.push(preset.alias);
      }
    }
    return {
      text: result.replace(/\n{3,}/g, "\n\n"),
      removed: removed,
      added: addedPresets.length > 0,
      addedPresets: addedPresets,
      migratedActiveModel: migratedActiveModel
    };
  }

  function migrateManagedVibeConfig(vibeHome) {
    var configFile = new File(vibeHome, "config.toml");
    if (!configFile.isFile()) {
      return { path: filePath(configFile), removed: [], migratedActiveModel: false };
    }
    var original = readTextFile(configFile);
    var patched = migrateManagedVibeModelPresets(original);
    if (patched.text !== original) {
      writeTextFile(configFile, patched.text);
    }
    return {
      path: filePath(configFile),
      removed: patched.removed,
      added: patched.added,
      migratedActiveModel: patched.migratedActiveModel
    };
  }

  function writeLocalVibeConfig(vibeHome, mcpEndpoint, model, options) {
    var configDir = new File(vibeHome);
    ensureDirectory(configDir);
    var configFile = new File(configDir, "config.toml");
    var gateway = isConvertigoGatewayProfile(options);
    var gatewayOptions = options || {};
    if (gateway && trim(model).length && !trim(gatewayOptions.llmGatewayDefaultModel).length) {
      gatewayOptions = withVibeProfile(gatewayOptions, "convertigo");
      gatewayOptions.llmGatewayDefaultModel = model;
    }
    var specs = gateway ? vibeGatewayModelSpecs(gatewayOptions, vibeHome) : [vibeModelSpec(model)];
    var spec = specs[0];
    for (var activeIndex = 0; activeIndex < specs.length; activeIndex++) {
      if (specs[activeIndex].alias === specs[activeIndex].activeModel) {
        spec = specs[activeIndex];
        break;
      }
    }
    var lines = gateway ? [
      '# Generated by lib_ConvertigoAgentBridge (Convertigo gateway profile).',
      'active_model = "' + tomlString(spec.activeModel) + '"',
      'api_timeout = 720.0',
      'auto_compact_threshold = 200000',
      '',
      '[[providers]]',
      'name = "convertigo"',
      'api_base = "' + tomlString(convertigoGatewayUrl(options)) + '"',
      'api_key_env_var = "' + CONVERTIGO_LLM_API_KEY_ENV + '"',
      'api_style = "openai"',
      'backend = "generic"',
      'reasoning_field_name = "reasoning_content"',
      '',
      '[providers.extra_headers]',
      ''
    ] : [
      '# Generated by lib_ConvertigoAgentBridge.',
      'active_model = "' + tomlString(spec.activeModel) + '"',
      'api_timeout = 720.0',
      'auto_compact_threshold = 200000',
      '',
      '[[providers]]',
      'name = "mistral"',
      'api_base = "https://api.mistral.ai/v1"',
      'api_key_env_var = "MISTRAL_API_KEY"',
      'browser_auth_base_url = "https://console.mistral.ai"',
      'browser_auth_api_base_url = "https://console.mistral.ai/api"',
      'api_style = "openai"',
      'backend = "mistral"',
      'reasoning_field_name = "reasoning_content"',
      'project_id = ""',
      'region = ""',
      '',
      '[providers.extra_headers]',
      ''
    ];
    for (var specIndex = 0; specIndex < specs.length; specIndex++) {
      var modelSpec = specs[specIndex];
      if (modelSpec.builtIn === true) {
        continue;
      }
      lines.push(
        '[[models]]',
        'name = "' + tomlString(modelSpec.name) + '"',
        'provider = "' + (gateway ? "convertigo" : "mistral") + '"',
        'alias = "' + tomlString(modelSpec.alias) + '"',
        'temperature = ' + modelSpec.temperature,
        'input_price = ' + modelSpec.inputPrice,
        'output_price = ' + modelSpec.outputPrice,
        modelSpec.thinking.length ? 'thinking = "' + tomlString(modelSpec.thinking) + '"' : '',
        'supports_images = ' + (modelSpec.supportsImages === true ? 'true' : 'false'),
        'auto_compact_threshold = 200000',
        ''
      );
    }
    lines.push(
      '[[mcp_servers]]',
      'name = "Convertigo"',
      'transport = "http"',
      'url = "' + tomlString(vibeMcpTransportEndpoint(mcpEndpoint, options)) + '"',
      'startup_timeout_sec = 60.0',
      ''
    );
    var viewerDebugPort = intValue(options && options.viewerDebugPort, 0, 0, 65535);
    if (usesProtectedConvertigoMcp(mcpEndpoint, options)) {
      lines.push(
        '[mcp_servers.auth]',
        'type = "static"',
        'api_key_env = "' + tomlString(mcpBearerTokenEnv(options)) + '"',
        'api_key_header = "Authorization"',
        'api_key_format = "Bearer {token}"',
        ''
      );
      var authHeaderLines = [];
      if (normalizeSkillProfile(options) === "nocode") {
        authHeaderLines.push('"X-Convertigo-Agent-Profile" = "nocode"');
      }
      if (viewerDebugPort >= 1024) {
        authHeaderLines.push('"X-Convertigo-Viewer-Debug-Port" = "' + String(viewerDebugPort) + '"');
      }
      if (revealModeEnabled(options, null)) {
        authHeaderLines.push('"X-Convertigo-Reveal-Mode" = "true"');
      }
      if (mcpNoLogEnabled(options)) {
        authHeaderLines.push('"X-Convertigo-No-Log" = "true"');
      }
      if (authHeaderLines.length) {
        lines.push('[mcp_servers.auth.headers]');
        lines = lines.concat(authHeaderLines);
        lines.push('');
      }
    }
    var playwright = vibePlaywrightServer(options);
    if (playwright !== null) {
      lines.push(
        '# The Studio JxBrowser CDP endpoint is written here because this Vibe home is viewer-scoped.',
        '[[mcp_servers]]',
        'name = "playwright"',
        'transport = "stdio"',
        '# `command` is a list on purpose: Vibe shlex-splits a string command, which',
        '# breaks Windows paths (backslashes, spaces).',
        'command = ' + tomlArray([playwright.command]),
        'args = ' + tomlArray(playwright.args),
        'startup_timeout_sec = 30.0',
        '',
        '[mcp_servers.env]',
        'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1"',
        ''
      );
    }
    var text = migrateManagedVibeModelPresets(lines.join("\n")).text;
    return {
      path: filePath(configFile),
      model: spec.activeModel,
      bytes: writeTextFile(configFile, text)
    };
  }

  // Vibe keys its persistent tool cache on the serialized server entry, so a
  // rewritten config leaves the entries discovered under the previous one behind
  // forever. They are a pure cache, rebuilt on the next discovery.
  function pruneVibeDescriptorCache(vibeHome) {
    var report = { attempted: false, removed: [], errors: [] };
    var home = trim(vibeHome);
    if (!home.length) {
      return report;
    }
    try {
      var dir = new File(new File(home, "logs"), "mcp-descriptors");
      if (!dir.isDirectory()) {
        return report;
      }
      report.attempted = true;
      deleteDirectoryTree(dir, report.removed, report.errors, false);
    } catch (e) {
      report.errors.push({ path: home, error: String(e) });
    }
    return report;
  }

  function vibePlaywrightEnabled(options) {
    options = options || {};
    if (boolValue(options.disablePlaywrightMcp || options.skipPlaywrightMcpConfig, false)) {
      return false;
    }
    if (normalizeSkillProfile(options) === "nocode") {
      return false;
    }
    if (!resolvePlaywrightMcpCdpEndpoint(options).length) {
      return false;
    }
    if (trim(options.vibeHome).length) {
      return true;
    }
    var scopeOption = trim(options.vibeHomeScope || options.homeScope || options.scope);
    return !scopeOption.length || normalizeScope(scopeOption) === "conversation";
  }

  function vibePlaywrightServer(options) {
    options = options || {};
    if (!vibePlaywrightEnabled(options)) {
      return null;
    }
    var workspaceRoot = resolveWorkspaceRoot(options);
    var installDir = normalizeDirectory(options.installDir, childPath(workspaceRoot, "agents/vibe"), workspaceRoot);
    if (!new File(childPath(childPath(codexNodeModulesPath(installDir), "@playwright/mcp"), "package.json")).isFile()) {
      return null;
    }
    // Vibe spawns stdio MCP servers from its Python process, whose PATH does not
    // include the Studio Node runtime: run the npx launcher through the explicit
    // node binary instead of relying on its shebang.
    var direct = playwrightMcpDirectLaunch(options, installDir);
    if (direct !== null) {
      return direct;
    }
    var npx = codexPlaywrightMcpCommand(options, installDir);
    var args = ["--prefix", codexNpmPrefix(installDir), codexPlaywrightMcpBinaryName(options), "--cdp-endpoint", resolvePlaywrightMcpCdpEndpoint(options), "--shared-browser-context"];
    var node = detectNodeRuntime(options);
    if (node.found && /\.js$/i.test(npx)) {
      return { command: node.path, args: [npx].concat(args) };
    }
    return { command: npx, args: args };
  }

  function ensureVibePlaywrightRuntime(options, installDir) {
    if (boolValue(options.skipPlaywrightInstall || options.skipVibePlaywrightInstall, false)) {
      return { attempted: false, installed: false, reused: false, skipped: true, method: "skipped", steps: [], timestamp: now() };
    }
    try {
      return ensureCodexPlaywrightRuntime(options, installDir);
    } catch (playwrightError) {
      return { attempted: true, installed: false, reused: false, skipped: false, method: "npm", error: String(playwrightError), steps: [], timestamp: now() };
    }
  }

  function detectRuntime(options) {
    var workspaceRoot = resolveWorkspaceRoot(options);
    var installDir = normalizeDirectory(options.installDir, childPath(workspaceRoot, "agents/vibe"), workspaceRoot);
    var venvDir = childPath(installDir, ".venv");
    var localPython = venvBinPath(venvDir, "python");
    var localVibe = venvBinPath(venvDir, "vibe");
    var localVibeAcp = venvBinPath(venvDir, "vibe-acp");
    var home = resolveVibeHome(options, installDir);
    var vibeHome = home.path;
    var mcpEndpoint = resolveMcpEndpoint(options);
    var model = vibeModelSpec(options.model || options.agentModel);
    var userHome = String(System.getProperty("user.home"));

    var homeLocalBin = childPath(userHome, ".local/bin");
    var pythonRuntime = detectPythonRuntime(options, localPython);

    return {
      workspaceRoot: workspaceRoot,
      installDir: installDir,
      venvDir: venvDir,
      vibeHome: vibeHome,
      home: publicHomeInfo(home),
      mcpEndpoint: mcpEndpoint,
      model: model.activeModel,
      python: pythonRuntime.command,
      pythonRuntime: pythonRuntime.runtime,
      uv: firstWorkingCommand([
        childPath(homeLocalBin, "uv"),
        "/opt/homebrew/bin/uv",
        "/usr/local/bin/uv",
        "uv"
      ], ["--version"]),
      vibe: firstWorkingCommand([
        localVibe,
        childPath(homeLocalBin, "vibe"),
        "/opt/homebrew/bin/vibe",
        "/usr/local/bin/vibe",
        "vibe"
      ], ["--version"]),
      vibeAcp: firstWorkingCommand([
        localVibeAcp,
        childPath(homeLocalBin, "vibe-acp"),
        "/opt/homebrew/bin/vibe-acp",
        "/usr/local/bin/vibe-acp",
        "vibe-acp"
      ], ["--version"]),
      config: {
        selected: vibeHome.length ? inspectVibeConfig(new File(vibeHome, "config.toml")) : {
          path: "",
          exists: false,
          hasMcpServers: false,
          hasConvertigoServer: false,
          hasHttpTransport: false,
          endpoint: "",
          valid: false
        },
        user: inspectVibeConfig(new File(new File(userHome, ".vibe"), "config.toml"))
      }
    };
  }

  function detectCodexRuntime(options) {
    options = options || {};
    var capabilityProfile = agentCapabilityProfile(options);
    var workspaceRoot = resolveWorkspaceRoot(options);
    var installDir = normalizeDirectory(options.installDir, childPath(workspaceRoot, "agents/codex"), workspaceRoot);
    var codexHome = resolveCodexHome(options, installDir);
    var userHome = String(System.getProperty("user.home"));
    var command = firstWorkingCommand([
      trim(options.codexPath || options.commandPath),
      codexLocalBin(installDir),
      "/Applications/Codex.app/Contents/Resources/codex",
      childPath(childPath(userHome, ".local"), "bin/codex"),
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
      "codex"
    ], ["--version"], nodeRuntimeSearchPath(options));
    var mcp = {
      checked: false,
      ok: false,
      hasConvertigo: false,
      hasLegacy: false,
      hasFlow: false,
      hasManagedServer: false,
      managedServerName: capabilityProfile.mcpServerName,
      hasPlaywright: false,
      stdout: "",
      stderr: "",
      error: ""
    };
    if (command.found) {
      var env = codexRuntimeEnv(options, codexHome.path);
      var mcpProbe = runCommand([command.path, "mcp", "list"], { timeoutMs: 15000, env: env });
      mcp.checked = true;
      mcp.ok = mcpProbe.ok;
      mcp.stdout = mcpProbe.stdout;
      mcp.stderr = mcpProbe.stderr;
      mcp.error = mcpProbe.error;
      var mcpText = String((mcpProbe.stdout || "") + "\n" + (mcpProbe.stderr || "")).toLowerCase();
      mcp.hasConvertigo = mcpText.indexOf("convertigo") >= 0;
      mcp.hasLegacy = mcpListHasServer(mcpText, "convertigo");
      mcp.hasFlow = mcpListHasServer(mcpText, "convertigo-flow");
      mcp.hasManagedServer = mcpListHasServer(mcpText, capabilityProfile.mcpServerName);
      mcp.hasPlaywright = mcpText.indexOf("playwright") >= 0;
    }
    return {
      workspaceRoot: workspaceRoot,
      installDir: installDir,
      codexHome: codexHome.path,
      home: publicHomeInfo(codexHome),
      mcpEndpoint: resolveMcpEndpoint(options),
      codex: command,
      playwright: detectCodexPlaywrightRuntime(options, installDir),
      mcp: mcp
    };
  }

  function mcpListHasServer(text, serverName) {
    var escaped = String(serverName || "").toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!escaped.length) {
      return false;
    }
    return new RegExp("(^|[\\s|])" + escaped + "(?=[\\s|]|$)", "m").test(String(text || "").toLowerCase());
  }

  function inspectCodexMcpConfig(codexHome, options) {
    var capabilityProfile = agentCapabilityProfile(options || {});
    var result = {
      checked: true,
      ok: false,
      hasConvertigo: false,
      hasLegacy: false,
      hasFlow: false,
      hasManagedServer: false,
      managedServerName: capabilityProfile.mcpServerName,
      hasPlaywright: false,
      stdout: "",
      stderr: "",
      error: ""
    };
    try {
      var configFile = new File(codexHome, "config.toml");
      if (!configFile.isFile()) {
        result.error = "config.toml not found";
        return result;
      }
      var text = readTextFile(configFile).toLowerCase();
      result.hasConvertigo = text.indexOf("convertigo") >= 0 && text.indexOf("mcp") >= 0;
      result.hasLegacy = text.indexOf("[mcp_servers.convertigo]") >= 0;
      result.hasFlow = text.indexOf("[mcp_servers.convertigo-flow]") >= 0;
      result.hasManagedServer = text.indexOf("[mcp_servers." + capabilityProfile.mcpServerName.toLowerCase() + "]") >= 0;
      result.hasPlaywright = text.indexOf("playwright") >= 0 && text.indexOf("mcp") >= 0;
      result.ok = capabilityProfile.id === "nocode"
        ? result.hasManagedServer
        : result.hasLegacy && (!flowCapabilityAvailable() || result.hasFlow);
    } catch (error) {
      result.error = String(error);
    }
    return result;
  }

  function detectCodexRuntimePresence(options) {
    options = options || {};
    var workspaceRoot = resolveWorkspaceRoot(options);
    var installDir = normalizeDirectory(options.installDir, childPath(workspaceRoot, "agents/codex"), workspaceRoot);
    var codexHome = resolveCodexHome(options, installDir);
    var userHome = String(System.getProperty("user.home"));
    var command = firstExistingCommand([
      trim(options.codexPath || options.commandPath),
      codexLocalBin(installDir),
      "/Applications/Codex.app/Contents/Resources/codex",
      childPath(childPath(userHome, ".local"), "bin/codex"),
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
      "codex"
    ], nodeRuntimeSearchPath(options));
    if (command.found && commandPathStartsWith(command, installDir)) {
      var version = installedNpmPackageVersion(installDir, npmPackageNameFromSpec(codexPackageSpec(options)));
      command.version = version.length ? "codex-cli " + version : "";
    }
    return {
      workspaceRoot: workspaceRoot,
      installDir: installDir,
      codexHome: codexHome.path,
      home: publicHomeInfo(codexHome),
      mcpEndpoint: resolveMcpEndpoint(options),
      codex: command,
      playwright: {
        installed: new File(childPath(codexNodeModulesPath(installDir), "@playwright/mcp/package.json")).isFile()
      },
      mcp: inspectCodexMcpConfig(codexHome.path, options)
    };
  }

  function detectRuntimePresence(options) {
    options = options || {};
    var workspaceRoot = resolveWorkspaceRoot(options);
    var installDir = normalizeDirectory(options.installDir, childPath(workspaceRoot, "agents/vibe"), workspaceRoot);
    var venvDir = childPath(installDir, ".venv");
    var vibeHomeInfo = resolveVibeHome(options, installDir);
    var vibeHome = vibeHomeInfo.path;
    var userHome = String(System.getProperty("user.home"));
    var homeLocalBin = childPath(userHome, ".local/bin");
    var vibe = firstExistingCommand([
      venvBinPath(venvDir, "vibe"),
      childPath(homeLocalBin, "vibe"),
      "vibe"
    ], "");
    var vibeAcp = firstExistingCommand([
      venvBinPath(venvDir, "vibe-acp"),
      childPath(homeLocalBin, "vibe-acp"),
      "vibe-acp"
    ], "");
    if (commandPathStartsWith(vibe, venvDir) && commandPathStartsWith(vibeAcp, venvDir)) {
      var installedVersion = installedPythonPackageVersion(venvDir, "mistral-vibe");
      vibe.version = installedVersion.length ? "vibe " + installedVersion : "";
      vibeAcp.version = installedVersion.length ? "vibe-acp " + installedVersion : "";
    }
    return {
      workspaceRoot: workspaceRoot,
      installDir: installDir,
      venvDir: venvDir,
      vibeHome: vibeHome,
      home: publicHomeInfo(vibeHomeInfo),
      mcpEndpoint: resolveMcpEndpoint(options),
      model: vibeModelSpec(options.model || options.agentModel).activeModel,
      python: firstExistingCommand([
        venvBinPath(venvDir, "python"),
        childPath(homeLocalBin, "python3"),
        childPath(homeLocalBin, "python"),
        "python3",
        "python"
      ], ""),
      pythonRuntime: {},
      uv: firstExistingCommand([
        venvBinPath(venvDir, "uv"),
        childPath(homeLocalBin, "uv"),
        "uv"
      ], ""),
      vibe: vibe,
      vibeAcp: vibeAcp,
      config: {
        selected: vibeHome.length ? inspectVibeConfig(new File(vibeHome, "config.toml")) : {
          path: "",
          exists: false,
          hasMcpServers: false,
          hasConvertigoServer: false,
          hasHttpTransport: false,
          endpoint: "",
          valid: false
        },
        user: inspectVibeConfig(new File(new File(userHome, ".vibe"), "config.toml"))
      }
    };
  }

  function codexRuntimeEnv(options, codexHomePath) {
    var env = {};
    options = options || {};
    var workspaceRoot = resolveWorkspaceRoot(options);
    var installDir = normalizeDirectory(options.installDir, childPath(workspaceRoot, "agents/codex"), workspaceRoot);
    var path = nodeRuntimeSearchPath(options);
    if (path.length) {
      env.PATH = path + String(File.pathSeparator) + String(System.getenv("PATH") || "");
    }
    if (trim(codexHomePath).length) {
      env.CODEX_HOME = trim(codexHomePath);
    }
    var cdpEndpoint = resolvePlaywrightMcpCdpEndpoint(options);
    if (cdpEndpoint.length) {
      env.PLAYWRIGHT_MCP_CDP_ENDPOINT = cdpEndpoint;
      env.PLAYWRIGHT_MCP_SHARED_BROWSER_CONTEXT = "1";
    }
    applyManagedMcpEnvironment(env, options);
    return env;
  }

  function normalizeCodexReasoningEffort(value) {
    var effort = trim(value).toLowerCase();
    if (!effort.length || effort === "default" || effort === "auto") {
      return "";
    }
    if (effort === "very-high" || effort === "very_high" || effort === "extra-high" || effort === "extra_high") {
      return "xhigh";
    }
    if (effort === "low" || effort === "medium" || effort === "high" || effort === "xhigh") {
      return effort;
    }
    return effort;
  }

  function codexReasoningLabel(effort) {
    var value = normalizeCodexReasoningEffort(effort);
    if (value === "low") {
      return "Low";
    }
    if (value === "medium") {
      return "Medium";
    }
    if (value === "high") {
      return "High";
    }
    if (value === "xhigh") {
      return "Very high";
    }
    return value;
  }

  function normalizeCodexReasoningLevels(levels) {
    var out = [];
    var seen = {};
    levels = levels || [];
    for (var i = 0; i < levels.length; i++) {
      var item = levels[i] || {};
      var effort = normalizeCodexReasoningEffort(item.effort || item.id || item.name);
      if (!effort.length || seen[effort]) {
        continue;
      }
      seen[effort] = true;
      out.push({
        id: effort,
        label: codexReasoningLabel(effort),
        description: String(item.description || "")
      });
    }
    return out;
  }

  function normalizeCodexServiceTiers(model) {
    var tiers = [];
    var seen = {};
    var raw = (model && model.service_tiers) || [];
    for (var i = 0; i < raw.length; i++) {
      var item = raw[i] || {};
      var id = trim(item.id || item.name);
      if (!id.length || seen[id]) {
        continue;
      }
      seen[id] = true;
      tiers.push({
        id: id,
        label: String(item.name || id),
        description: String(item.description || "")
      });
    }
    return tiers;
  }

  function normalizeCodexModelCatalog(catalog) {
    var models = [];
    var raw = catalog && catalog.models ? catalog.models : [];
    for (var i = 0; i < raw.length; i++) {
      var item = raw[i] || {};
      var id = trim(item.slug || item.id || item.name);
      if (!id.length || trim(item.visibility).toLowerCase() === "hide") {
        continue;
      }
      var reasoning = normalizeCodexReasoningLevels(item.supported_reasoning_levels || item.supportedReasoningLevels);
      var defaultReasoning = normalizeCodexReasoningEffort(item.default_reasoning_level || item.defaultReasoningLevel);
      models.push({
        id: id,
        label: String(item.display_name || item.displayName || id),
        description: String(item.description || ""),
        defaultReasoning: defaultReasoning,
        reasoningLevels: reasoning,
        serviceTiers: normalizeCodexServiceTiers(item),
        speedTiers: item.additional_speed_tiers || item.additionalSpeedTiers || [],
        priority: intValue(item.priority, 9999, -9999, 999999)
      });
    }
    models.sort(function (a, b) {
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }
      return a.label < b.label ? -1 : (a.label > b.label ? 1 : 0);
    });
    return models;
  }

  function compactCommandStatus(command) {
    command = command || {};
    return {
      found: command.found === true,
      path: String(command.path || ""),
      version: String(command.version || ""),
      error: String(command.error || "")
    };
  }

  function compactVibeConfig(config) {
    config = config || {};
    return {
      path: String(config.path || ""),
      exists: config.exists === true,
      hasConvertigoServer: config.hasConvertigoServer === true,
      hasHttpTransport: config.hasHttpTransport === true,
      bearerTokenEnv: String(config.bearerTokenEnv || ""),
      endpoint: String(config.endpoint || ""),
      valid: config.valid === true
    };
  }

  function compactCodexSetup(setup) {
    setup = setup || {};
    var mcp = setup.mcp || {};
    return {
      workspaceRoot: String(setup.workspaceRoot || ""),
      installDir: String(setup.installDir || ""),
      codexHome: String(setup.codexHome || ""),
      home: setup.home || {},
      mcpEndpoint: String(setup.mcpEndpoint || ""),
      codex: compactCommandStatus(setup.codex),
      mcp: {
        checked: mcp.checked === true,
        ok: mcp.ok === true,
        hasConvertigo: mcp.hasConvertigo === true,
        hasManagedServer: mcp.hasManagedServer === true,
        managedServerName: String(mcp.managedServerName || ""),
        error: String(mcp.error || "")
      }
    };
  }

  function compactVibeSetup(setup) {
    setup = setup || {};
    var config = setup.config || {};
    return {
      workspaceRoot: String(setup.workspaceRoot || ""),
      installDir: String(setup.installDir || ""),
      venvDir: String(setup.venvDir || ""),
      vibeHome: String(setup.vibeHome || ""),
      home: setup.home || {},
      mcpEndpoint: String(setup.mcpEndpoint || ""),
      model: String(setup.model || ""),
      python: compactCommandStatus(setup.python),
      uv: compactCommandStatus(setup.uv),
      vibe: compactCommandStatus(setup.vibe),
      vibeAcp: compactCommandStatus(setup.vibeAcp),
      config: {
        selected: compactVibeConfig(config.selected),
        user: compactVibeConfig(config.user)
      }
    };
  }

  function extractRuntimeVersion(value) {
    var match = String(value || "").match(/(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)/);
    return match ? match[1] : "";
  }

  function compareRuntimeVersions(left, right) {
    var leftVersion = extractRuntimeVersion(left);
    var rightVersion = extractRuntimeVersion(right);
    if (!leftVersion.length || !rightVersion.length) {
      return 0;
    }
    var leftCore = leftVersion.split(/[+-]/)[0].split(".");
    var rightCore = rightVersion.split(/[+-]/)[0].split(".");
    var length = Math.max(leftCore.length, rightCore.length);
    for (var i = 0; i < length; i++) {
      var leftPart = parseInt(leftCore[i] || "0", 10);
      var rightPart = parseInt(rightCore[i] || "0", 10);
      if (leftPart < rightPart) {
        return -1;
      }
      if (leftPart > rightPart) {
        return 1;
      }
    }
    var leftPrerelease = leftVersion.indexOf("-") >= 0;
    var rightPrerelease = rightVersion.indexOf("-") >= 0;
    if (leftPrerelease !== rightPrerelease) {
      return leftPrerelease ? -1 : 1;
    }
    return 0;
  }

  function runtimeUpdateStatus(provider, command, latest, source) {
    command = command || {};
    latest = latest || {};
    var installedVersion = extractRuntimeVersion(command.version);
    var latestVersion = extractRuntimeVersion(latest.latestVersion);
    return {
      provider: provider,
      installed: command.found === true,
      managed: command.found === true && latest.managedPathPrefix && commandPathStartsWith(command, latest.managedPathPrefix),
      path: String(command.path || ""),
      installedVersion: installedVersion,
      latestVersion: latestVersion,
      checked: latest.checked === true,
      cached: latest.cached === true,
      updateAvailable: installedVersion.length > 0 && latestVersion.length > 0 && compareRuntimeVersions(installedVersion, latestVersion) < 0,
      source: source,
      error: String(latest.error || ""),
      checkedAt: Number(latest.checkedAt || 0),
      nextCheckAt: Number(latest.nextCheckAt || 0)
    };
  }

  function codexLatestVersion(options, setup) {
    options = options || {};
    if (!setup.codex || setup.codex.found !== true) {
      return {
        checked: false,
        latestVersion: "",
        error: "",
        checkedAt: 0,
        managedPathPrefix: String(setup.installDir || "")
      };
    }
    var packageName = npmPackageNameFromSpec(codexPackageSpec(options));
    var cacheKey = "codex:" + packageName;
    if (!boolValue(options.checkUpdates, false)) {
      var cachedLatest = readCachedRuntimeUpdate(cacheKey, setup.workspaceRoot);
      if (cachedLatest !== null) {
        cachedLatest.managedPathPrefix = String(setup.installDir || "");
        return cachedLatest;
      }
      return {
        checked: false,
        latestVersion: "",
        error: "",
        checkedAt: 0,
        managedPathPrefix: String(setup.installDir || "")
      };
    }
    var latest = cachedRuntimeUpdate(cacheKey, options, setup.workspaceRoot, function () {
      var npmRuntime = detectNpmRuntime(options);
      if (!npmRuntime.npm.found) {
        return {
          checked: true,
          latestVersion: "",
          error: "npm not found"
        };
      }
      var probe = runNpmCommand(npmRuntime.npm, ["view", packageName, "version", "--json"], {
        timeoutMs: intValue(options.updateCheckTimeoutMs, 20000, 1000, 120000)
      });
      var parsed = parseJsonSafe(probe.stdout, "");
      var value = typeof parsed === "string" ? parsed : probe.stdout;
      return {
        checked: true,
        latestVersion: extractRuntimeVersion(value),
        error: probe.ok ? "" : String(probe.stderr || probe.error || "npm version check failed")
      };
    });
    latest.managedPathPrefix = String(setup.installDir || "");
    return latest;
  }

  function vibeLatestVersion(options, setup) {
    options = options || {};
    if (!setup.vibe || setup.vibe.found !== true) {
      return {
        checked: false,
        latestVersion: "",
        error: "",
        checkedAt: 0,
        managedPathPrefix: String(setup.venvDir || "")
      };
    }
    var cacheKey = "vibe:mistral-vibe";
    if (!boolValue(options.checkUpdates, false)) {
      var cachedLatest = readCachedRuntimeUpdate(cacheKey, setup.workspaceRoot);
      if (cachedLatest !== null) {
        cachedLatest.managedPathPrefix = String(setup.venvDir || "");
        return cachedLatest;
      }
      return {
        checked: false,
        latestVersion: "",
        error: "",
        checkedAt: 0,
        managedPathPrefix: String(setup.venvDir || "")
      };
    }
    var latest = cachedRuntimeUpdate(cacheKey, options, setup.workspaceRoot, function () {
      if (!setup.python || !setup.python.found) {
        return {
          checked: true,
          latestVersion: "",
          error: "Python not found"
        };
      }
      var probe = runCommandCaptured([setup.python.path, "-m", "pip", "index", "versions", "mistral-vibe"], {
        proxyTargetUrl: "https://pypi.org",
        timeoutMs: intValue(options.updateCheckTimeoutMs, 20000, 1000, 120000)
      });
      var text = String((probe.stdout || "") + "\n" + (probe.stderr || ""));
      var match = text.match(/mistral-vibe\s*\(([^)]+)\)/i) || text.match(/Available versions:\s*([^\s,]+)/i);
      return {
        checked: true,
        latestVersion: match ? extractRuntimeVersion(match[1]) : "",
        error: probe.ok ? "" : String(probe.stderr || probe.error || "PyPI version check failed")
      };
    });
    latest.managedPathPrefix = String(setup.venvDir || "");
    return latest;
  }

  function codexSettings(options) {
    options = optionsWithRequestFallbacks(options);
    var capabilityProfile = publicAgentCapabilityProfile(options);
    var presenceOnly = boolValue(options.runtimePresenceOnly, false);
    var setup = presenceOnly ? detectCodexRuntimePresence(options) : detectCodexRuntime(options);
    var runtime = runtimeUpdateStatus("codex", setup.codex, codexLatestVersion(options, setup), "npm");
    var source = {
      type: presenceOnly ? "presence" : "cli",
      command: presenceOnly ? String(setup.codex.path || "") : (setup.codex.found ? setup.codex.path + " debug models" : "codex debug models"),
      ok: presenceOnly && setup.codex.found === true,
      exitCode: -1,
      error: "",
      stderr: ""
    };
    var models = [];
    var bootstrap = null;
    var skills = null;
    if (setup.codex.found && !presenceOnly) {
      try {
        if (trim(setup.codexHome).length) {
          bootstrap = bootstrapCodexHome(options, setup.codexHome, resolveMcpEndpoint(options));
          skills = installAgentSkills(options, "codex", setup.codexHome);
          setup = detectCodexRuntime(options);
        }
      } catch (_ignoreCodexHomePrepare) {}
      var probe = runCommandCaptured([setup.codex.path, "debug", "models"], {
        timeoutMs: intValue(options.settingsTimeoutMs || options.modelsTimeoutMs, 60000, 1000, 180000),
        env: codexRuntimeEnv(options, setup.codexHome)
      });
      source.ok = probe.ok;
      source.exitCode = probe.exitCode;
      source.error = probe.error;
      source.stderr = probe.stderr;
      if (probe.ok) {
        models = normalizeCodexModelCatalog(parseJsonSafe(probe.stdout, {}));
      }
    } else if (!setup.codex.found) {
      source.error = "Codex CLI not found";
    }
    var defaultModel = models.length ? models[0].id : "";
    return {
      id: "codex",
      label: "Codex",
      status: setup.codex.found ? "ready" : "missing",
      ready: setup.codex.found === true,
      runtime: runtime,
      authentication: verifiedCodexAuthentication(options, setup.codexHome, setup.codex.path, !presenceOnly && bootstrap && bootstrap.authenticationImported === true),
      setup: compactCodexSetup(setup),
      bootstrap: bootstrap,
      skills: skills,
      source: source,
      defaultModel: defaultModel,
      models: models,
      reasoningMode: "per_model",
      profileSupported: capabilityProfile.supportedProviders.indexOf("codex") >= 0,
      supports: {
        resume: true,
        stop: true,
        images: true,
        mcp: setup.mcp.hasManagedServer === true,
        reasoning: true,
        serviceTier: true
      },
      agentProfile: capabilityProfile
    };
  }

  function parseTomlValue(text, key) {
    var pattern = new RegExp("^\\s*" + key + "\\s*=\\s*['\\\"]?([^'\\\"\\n#]+)", "m");
    var match = String(text || "").match(pattern);
    return match ? trim(match[1]) : "";
  }

  function parseVibeModelsFromConfig(file) {
    var result = {
      path: filePath(file),
      exists: file.exists(),
      activeModel: "",
      models: []
    };
    if (!result.exists) {
      return result;
    }
    var text = readTextFile(file);
    result.activeModel = parseTomlValue(text, "active_model");
    var blockPattern = /\[\[models\]\]([\s\S]*?)(?=\n\[\[|\n\[|$)/g;
    var blockMatch;
    while ((blockMatch = blockPattern.exec(text)) !== null) {
      var block = blockMatch[1];
      var name = parseTomlValue(block, "name");
      var alias = parseTomlValue(block, "alias");
      var provider = parseTomlValue(block, "provider");
      var thinking = parseTomlValue(block, "thinking");
      var id = alias || name;
      if (!id.length) {
        continue;
      }
      result.models.push({
        id: id,
        label: id,
        configuredName: name,
        provider: provider,
        defaultReasoning: thinking,
        reasoningLevels: thinking.length ? [{
          id: thinking,
          label: thinking,
          description: "Configured by Vibe model"
        }] : [],
        serviceTiers: [],
        speedTiers: []
      });
    }
    return result;
  }

  function vibeConfigRequiresAuthMigration(text) {
    var lines = String(text || "").split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      if (trim(lines[i]) !== "[[mcp_servers]]") {
        continue;
      }
      var end = lines.length;
      for (var endIndex = i + 1; endIndex < lines.length; endIndex++) {
        var section = trim(lines[endIndex]);
        var nestedMcpSection = section === "[mcp_servers.headers]" ||
          section === "[mcp_servers.auth]" || section === "[mcp_servers.auth.headers]";
        if (/^\[\[.+\]\]$/.test(section) || (/^\[.+\]$/.test(section) && !nestedMcpSection)) {
          end = endIndex;
          break;
        }
      }
      var isConvertigo = false;
      var hasAuth = false;
      var hasLegacyHeaders = false;
      var hasParentInlineHeaders = false;
      var currentSection = "parent";
      for (var lineIndex = i + 1; lineIndex < end; lineIndex++) {
        var line = trim(lines[lineIndex]);
        if (/^\[.+\]$/.test(line)) {
          currentSection = line;
          hasAuth = hasAuth || line === "[mcp_servers.auth]";
          hasLegacyHeaders = hasLegacyHeaders || line === "[mcp_servers.headers]";
        } else if (currentSection === "parent") {
          isConvertigo = isConvertigo || /^name\s*=\s*["']Convertigo["']\s*$/.test(line);
          hasParentInlineHeaders = hasParentInlineHeaders || /^headers\s*=/.test(line);
        }
      }
      if (isConvertigo) {
        return hasAuth && (hasLegacyHeaders || hasParentInlineHeaders);
      }
    }
    return false;
  }

  function acpConfigOptions(value) {
    value = value || {};
    var options = value.configOptions || value.config_options || value;
    return options && typeof options.length !== "undefined" ? options : [];
  }

  function findAcpConfigOption(configOptions, id) {
    var wanted = trim(id).toLowerCase();
    var options = acpConfigOptions(configOptions);
    for (var i = 0; i < options.length; i++) {
      var option = options[i] || {};
      if (trim(option.id || option.configId || option.config_id || option.category).toLowerCase() === wanted) {
        return option;
      }
    }
    return null;
  }

  function normalizeAcpSelectOptions(option) {
    var result = [];
    var seen = {};
    var options = option && option.options ? option.options : [];
    for (var i = 0; i < options.length; i++) {
      var item = options[i] || {};
      var id = trim(item.value || item.id || item.name);
      if (!id.length || seen[id]) {
        continue;
      }
      seen[id] = true;
      result.push({
        id: id,
        label: String(item.name || item.label || id),
        description: String(item.description || "")
      });
    }
    return result;
  }

  function normalizeVibeAcpProviderSettings(configOptions, provider) {
    provider = provider || {};
    var modelOption = findAcpConfigOption(configOptions, "model");
    var thinkingOption = findAcpConfigOption(configOptions, "thinking");
    var modelChoices = normalizeAcpSelectOptions(modelOption);
    var convertigoMode = normalizeProvider(provider.id) === "convertigo";
    var gatewayAliases = convertigoMode && provider.gateway && provider.gateway.models ? provider.gateway.models : [];
    if (gatewayAliases.length) {
      // Vibe always advertises its built-in Mistral models; the Convertigo home has no key for
      // that provider, so only the gateway offer is selectable.
      var offered = [];
      for (var choiceIndex = 0; choiceIndex < modelChoices.length; choiceIndex++) {
        if (gatewayAliases.indexOf(modelChoices[choiceIndex].id) >= 0) { offered.push(modelChoices[choiceIndex]); }
      }
      if (offered.length) { modelChoices = offered; }
    }
    if (!modelChoices.length) {
      return provider;
    }
    var reasoningLevels = normalizeAcpSelectOptions(thinkingOption);
    var defaultReasoning = trim(thinkingOption && (thinkingOption.currentValue || thinkingOption.current_value));
    var gatewayEfforts = convertigoMode && provider.gateway && provider.gateway.efforts ? provider.gateway.efforts : {};
    var models = [];
    for (var i = 0; i < modelChoices.length; i++) {
      var model = modelChoices[i];
      var modelLevels = reasoningLevels, modelDefaultReasoning = defaultReasoning;
      var vibePreset = convertigoMode ? null : managedVibeGlmPreset(model.id);
      if (Object.prototype.hasOwnProperty.call(gatewayEfforts, model.id) || vibePreset !== null) {
        // Only the levels this model accepts, plus the "off" choice Vibe offers.
        var accepted = vibePreset !== null ? vibePreset.efforts : gatewayEfforts[model.id];
        modelLevels = reasoningLevels.filter(function (level) {
          var id = String(level.id).toLowerCase();
          return id === "off" || id === "none" || accepted.indexOf(id) >= 0;
        });
        modelDefaultReasoning = gatewayEffortFor(defaultReasoning, accepted) || defaultReasoning;
      }
      models.push({
        id: model.id,
        label: model.label,
        description: model.description,
        configuredName: model.description,
        provider: convertigoMode ? "convertigo" : "mistral",
        defaultReasoning: modelDefaultReasoning,
        reasoningLevels: modelLevels,
        serviceTiers: [],
        speedTiers: []
      });
    }
    // Keep the logical Convertigo mode identity when the ACP catalog refreshes it.
    provider.id = normalizeProvider(provider.id) === "convertigo" ? "convertigo" : "vibe";
    provider.label = provider.label || (provider.id === "convertigo" ? "Convertigo" : "Vibe");
    provider.defaultModel = trim(modelOption.currentValue || modelOption.current_value) || models[0].id;
    var defaultOffered = false;
    for (var offeredIndex = 0; offeredIndex < models.length; offeredIndex++) {
      if (models[offeredIndex].id === provider.defaultModel) { defaultOffered = true; }
    }
    if (!defaultOffered) { provider.defaultModel = models[0].id; }
    provider.models = models;
    provider.reasoningMode = reasoningLevels.length ? "runtime_selectable" : "model_bound";
    provider.supports = provider.supports || {};
    provider.supports.reasoning = reasoningLevels.length > 0;
    provider.source = provider.source || {};
    provider.source.type = "acp";
    provider.source.ok = true;
    provider.source.error = "";
    provider.source.settingsCached = false;
    provider.source.settingsCachedAt = 0;
    provider.source.modelCatalogRefreshRequired = false;
    delete provider.source.discoveryError;
    return provider;
  }

  function updateVibeProviderSettings(entry, configOptions, provider) {
    if (!entry || normalizeProvider(entry.provider) !== "vibe") {
      return provider || null;
    }
    var base = provider || entry.providerSettings || {
      id: "vibe",
      label: "Vibe",
      ready: true,
      status: "ready",
      source: {},
      supports: {
        resume: true,
        stop: true,
        images: false,
        mcp: true,
        reasoning: false,
        serviceTier: false
      }
    };
    base.settingsCacheKey = (normalizeProvider(base.id) === "convertigo" ? "convertigo:" : "") + providerSettingsCacheKey("vibe", entry.home && entry.home.path);
    var settings = normalizeVibeAcpProviderSettings(configOptions, base);
    if (!settings.models || !settings.models.length) {
      return settings;
    }
    entry.configOptions = acpConfigOptions(configOptions);
    entry.providerSettings = settings;
    entry.model = settings.defaultModel || entry.model || "";
    entry.reasoningEffort = providerDefaultReasoning(settings) || entry.reasoningEffort || "";
    writePersistentProviderSettingsCache(entry.workspaceRoot || "", [settings]);
    return settings;
  }

  function acpConfigOptionHasValue(option, value) {
    var wanted = trim(value);
    if (!option || !wanted.length) {
      return false;
    }
    var choices = normalizeAcpSelectOptions(option);
    for (var i = 0; i < choices.length; i++) {
      if (choices[i].id === wanted) {
        return true;
      }
    }
    return false;
  }

  function configureVibeSession(entry, options, timeoutMs) {
    options = options || {};
    var requestedModel = trim(options.model || options.agentModel);
    var requestedReasoning = trim(options.reasoningEffort || options.reasoningLevel || options.modelReasoningEffort);
    var configOptions = entry.configOptions || acpConfigOptions(entry.session);
    var modelOption = findAcpConfigOption(configOptions, "model");
    if (requestedModel.length && acpConfigOptionHasValue(modelOption, requestedModel) && requestedModel !== trim(modelOption.currentValue || modelOption.current_value)) {
      var modelResult = acpRequest(entry, "session/set_config_option", {
        sessionId: entry.sessionId,
        configId: "model",
        value: requestedModel
      }, timeoutMs);
      configOptions = acpConfigOptions(modelResult);
      updateVibeProviderSettings(entry, configOptions);
    } else if (requestedModel.length && !acpConfigOptionHasValue(modelOption, requestedModel)) {
      pushEvent(entry, "warning", {
        phase: "session/config",
        message: "Requested Vibe model is not available for this profile: " + requestedModel
      });
    }
    var thinkingOption = findAcpConfigOption(configOptions, "thinking");
    var convertigoSession = isConvertigoGatewayProfile(options) || (entry.providerSettings && normalizeProvider(entry.providerSettings.id) === "convertigo");
    if (convertigoSession && thinkingOption) {
      // The thinking level is a session value while its accepted values depend on the model:
      // re-align it whenever the model or the level changes (medium is refused by GLM 5.3).
      var activeModelOption = findAcpConfigOption(configOptions, "model");
      var activeAlias = trim(activeModelOption && (activeModelOption.currentValue || activeModelOption.current_value)) || requestedModel;
      var currentThinking = trim(thinkingOption.currentValue || thinkingOption.current_value);
      var alignedReasoning = gatewayEffortFor(requestedReasoning || currentThinking, gatewayEffortsForAlias(options, activeAlias));
      if (alignedReasoning.length && alignedReasoning !== (requestedReasoning || currentThinking)) {
        pushEvent(entry, "warning", {
          phase: "session/config",
          message: "Thinking level " + (requestedReasoning || currentThinking) + " is not accepted by " + activeAlias + "; using " + alignedReasoning + "."
        });
      }
      if (alignedReasoning.length) { requestedReasoning = alignedReasoning; }
    } else if (thinkingOption) {
      var presetModelOption = findAcpConfigOption(configOptions, "model");
      var presetForSession = managedVibeGlmPreset(trim(presetModelOption && (presetModelOption.currentValue || presetModelOption.current_value)) || requestedModel);
      if (presetForSession !== null) {
        var presetThinking = requestedReasoning || trim(thinkingOption.currentValue || thinkingOption.current_value);
        var alignedPresetThinking = gatewayEffortFor(presetThinking, presetForSession.efforts);
        if (alignedPresetThinking.length && alignedPresetThinking !== presetThinking) {
          pushEvent(entry, "warning", {
            phase: "session/config",
            message: "Thinking level " + presetThinking + " is not accepted by " + presetForSession.alias + "; using " + alignedPresetThinking + "."
          });
          requestedReasoning = alignedPresetThinking;
        }
      }
    }
    if (requestedReasoning.length && acpConfigOptionHasValue(thinkingOption, requestedReasoning) && requestedReasoning !== trim(thinkingOption.currentValue || thinkingOption.current_value)) {
      var reasoningResult = acpRequest(entry, "session/set_config_option", {
        sessionId: entry.sessionId,
        configId: "thinking",
        value: requestedReasoning
      }, timeoutMs);
      configOptions = acpConfigOptions(reasoningResult);
      updateVibeProviderSettings(entry, configOptions);
    } else if (requestedReasoning.length && !acpConfigOptionHasValue(thinkingOption, requestedReasoning)) {
      pushEvent(entry, "warning", {
        phase: "session/config",
        message: "Requested Vibe thinking level is not available for this profile: " + requestedReasoning
      });
    }
    return updateVibeProviderSettings(entry, configOptions);
  }

  function vibeSettings(options) {
    options = optionsWithRequestFallbacks(options);
    var gatewayProfile = isConvertigoGatewayProfile(options);
    var presenceOnly = boolValue(options.runtimePresenceOnly, false);
    var capabilityProfile = publicAgentCapabilityProfile(options);
    var profileSupported = capabilityProfile.supportedProviders.indexOf("vibe") >= 0;
    // Settings read installed metadata; execution is checked by ACP discovery/start.
    var setup = detectRuntimePresence(options);
    var managedVibeReady = commandPathStartsWith(setup.vibe, setup.venvDir) && commandPathStartsWith(setup.vibeAcp, setup.venvDir);
    var runtimeCommand = managedVibeReady ? setup.vibe : { found: false, path: "", version: "" };
    var runtime = runtimeUpdateStatus("vibe", runtimeCommand, vibeLatestVersion(options, setup), "pypi");
    var skills = null;
    if (!presenceOnly && managedVibeReady && trim(setup.vibeHome).length) {
      var vibeConfigFile = new File(setup.vibeHome, "config.toml");
      if (vibeConfigFile.isFile() && vibeConfigRequiresAuthMigration(readTextFile(vibeConfigFile))) {
        skills = installAgentSkills(options, "vibe", setup.vibeHome);
        setup = detectRuntimePresence(options);
      }
    }
    var selectedFile = setup.vibeHome.length ? new File(setup.vibeHome, "config.toml") : null;
    var selected = selectedFile !== null ? parseVibeModelsFromConfig(selectedFile) : { path: "", exists: false, activeModel: "", models: [] };
    var user = gatewayProfile ? { path: "", exists: false, activeModel: "", models: [] } : parseVibeModelsFromConfig(new File(new File(String(System.getProperty("user.home")), ".vibe"), "config.toml"));
    var config = selected.exists ? selected : user;
    var models = config.models;
    // The Convertigo mode always lists the gateway offer, never what an older config.toml
    // still declares: the offer can change between two conversations.
    var gatewaySpecs = gatewayProfile ? vibeGatewayModelSpecs(options, setup.vibeHome) : [];
    if (gatewayProfile || (!models.length && setup.model)) {
      var settingSpecs = gatewayProfile ? gatewaySpecs : [vibeModelSpec(setup.model)];
      models = [];
      for (var settingIndex = 0; settingIndex < settingSpecs.length; settingIndex++) {
        var spec = settingSpecs[settingIndex];
        models.push({
          id: gatewayProfile ? spec.alias : spec.activeModel,
          label: gatewayProfile ? spec.alias : spec.activeModel,
          configuredName: spec.name,
          provider: gatewayProfile ? "convertigo" : "mistral",
          defaultReasoning: spec.thinking,
          reasoningLevels: gatewayProfile && spec.efforts ? spec.efforts.map(function (level) {
            return { id: level, label: level, description: "Accepted by this gateway model" };
          }) : (spec.thinking.length ? [{
            id: spec.thinking,
            label: spec.thinking,
            description: "Configured by Vibe model"
          }] : []),
          serviceTiers: [],
          speedTiers: []
        });
      }
    }
    var gatewayAliases = [], gatewayEfforts = {};
    for (var aliasIndex = 0; aliasIndex < gatewaySpecs.length; aliasIndex++) {
      gatewayAliases.push(gatewaySpecs[aliasIndex].alias);
      if (gatewaySpecs[aliasIndex].efforts) { gatewayEfforts[gatewaySpecs[aliasIndex].alias] = gatewaySpecs[aliasIndex].efforts; }
    }
    var configuredDefault = trim(config.activeModel);
    if (gatewayProfile && gatewayAliases.indexOf(configuredDefault) < 0) {
      configuredDefault = gatewaySpecs.length ? gatewaySpecs[0].activeModel : "";
    }
    var defaultModel = configuredDefault || setup.model || (models.length ? models[0].id : "");
    var provider = {
      id: gatewayProfile ? "convertigo" : "vibe",
      label: gatewayProfile ? "Convertigo" : "Vibe",
      // The Convertigo mode is a logical provider; `harness` names the CLI actually
      // driving it so the Assistant never hard-codes Vibe for it.
      harness: "vibe",
      profile: resolveVibeProfile(options),
      gateway: gatewayProfile ? { url: convertigoGatewayUrl(options), model: gatewaySpecs.length ? gatewaySpecs[0].name : convertigoGatewayModel(options), models: gatewayAliases, efforts: gatewayEfforts, apiKeyEnv: CONVERTIGO_LLM_API_KEY_ENV } : null,
      identity: gatewayProfile ? { email: studioOwnerEmail() } : null,
      status: profileSupported ? (managedVibeReady ? "ready" : "missing") : "unsupported_profile",
      ready: profileSupported && managedVibeReady,
      runtime: runtime,
      authentication: gatewayProfile && convertigoGatewayKeyRejected
        ? rejectedGatewayKeyAuthentication(options)
        : inspectVibeAuthentication(setup.vibeHome, resolveVibeProfile(options)),
      setup: compactVibeSetup(setup),
      skills: skills,
      source: {
        type: config.exists ? "config" : "fallback",
        path: config.path,
        ok: config.exists || models.length > 0,
        error: config.exists || models.length > 0 ? "" : "Vibe config has no models"
      },
      defaultModel: defaultModel,
      models: models,
      reasoningMode: "model_bound",
      profileSupported: profileSupported,
      supports: {
        resume: true,
        stop: true,
        images: false,
        mcp: profileSupported && (setup.config.selected.valid || setup.config.user.hasConvertigoServer),
        reasoning: false,
        serviceTier: false
      },
      agentProfile: capabilityProfile
    };
    provider.settingsCacheKey = providerSettingsCacheKey("vibe", setup.vibeHome);
    if (gatewayProfile) {
      provider.settingsCacheKey = "convertigo:" + provider.settingsCacheKey;
    }
    provider = hydrateProviderSettingsFromCache(setup.workspaceRoot, provider, true);
    if (!presenceOnly && managedVibeReady && commandPathStartsWith({ path: setup.vibeHome }, setup.installDir)) {
      var presetUpdate = migrateManagedVibeConfig(setup.vibeHome);
      if (presetUpdate.removed.length || presetUpdate.added) {
        provider.source = provider.source || {};
        provider.source.modelCatalogRefreshRequired = true;
        provider.source.settingsCachedAt = 0;
        provider.source.modelPresetsRemoved = presetUpdate.removed;
        provider.source.activeModelMigrated = presetUpdate.migratedActiveModel;
      }
      var configuredModels = parseVibeModelsFromConfig(new File(setup.vibeHome, "config.toml")).models;
      if (configuredModels.some(function (model) {
        return !provider.models.some(function (cached) { return cached.id === model.id; });
      })) {
        provider.source.modelCatalogRefreshRequired = true;
        provider.source.settingsCachedAt = 0;
      }
    }
    return provider;
  }

  function canonicalFilePath(file) {
    if (file === null || typeof file === "undefined") {
      return "";
    }
    try {
      return String(file.getCanonicalPath());
    } catch (_ignoreCanonicalPath) {
      return filePath(file);
    }
  }

  function deleteDirectoryTree(file, removed, errors, nested) {
    if (file === null || !file.exists()) {
      return true;
    }
    if (file.isDirectory()) {
      var children = file.listFiles();
      if (children !== null) {
        for (var i = 0; i < children.length; i++) {
          if (!deleteDirectoryTree(children[i], removed, errors, true)) {
            return false;
          }
        }
      }
    }
    try {
      if (file["delete"]()) {
        if (nested !== true) {
          removed.push(filePath(file));
        }
        return true;
      }
    } catch (e) {
      errors.push({ path: filePath(file), error: String(e) });
      return false;
    }
    errors.push({ path: filePath(file), error: "delete returned false" });
    return false;
  }

  function removeDirectoryWhenEmpty(file, removed) {
    try {
      if (file !== null && file.isDirectory()) {
        var children = file.listFiles();
        if (children !== null && children.length === 0 && file["delete"]()) {
          removed.push(filePath(file));
        }
      }
    } catch (_ignoreRemoveEmptyDirectory) {}
  }

  function homeContainerPath(value) {
    var raw = trim(value);
    if (!raw.length) {
      return "";
    }
    var path = canonicalFilePath(new File(raw));
    if (!path.length) {
      return "";
    }
    var file = new File(path);
    var name = String(file.getName());
    if (name === "codex-home" || name === ".codex-home") {
      return canonicalFilePath(file.getParentFile());
    }
    return path;
  }

  function addProtectedHome(paths, value) {
    var path = homeContainerPath(value);
    if (path.length) {
      paths[path] = true;
    }
  }

  function homeContainsReferencedSession(file, sessionIds, depth) {
    if (file === null || !file.exists() || depth > 10) {
      return false;
    }
    if (file.isFile()) {
      var name = String(file.getName());
      for (var sessionId in sessionIds) {
        if (Object.prototype.hasOwnProperty.call(sessionIds, sessionId) && name.indexOf(sessionId) >= 0) {
          return true;
        }
      }
      return false;
    }
    var children = file.listFiles();
    if (children === null) {
      return false;
    }
    for (var i = 0; i < children.length; i++) {
      if (homeContainsReferencedSession(children[i], sessionIds, depth + 1)) {
        return true;
      }
    }
    return false;
  }

  function activeAgentStorageReferences(workspaceRoot) {
    var references = {
      conversationIds: {},
      homePaths: {},
      sessionIds: {},
      tombstones: []
    };
    var providers = ["codex", "vibe", "claude"];
    for (var providerIndex = 0; providerIndex < providers.length; providerIndex++) {
      var provider = providers[providerIndex];
      var usersRoot = new File(new File(new File(workspaceRoot, "agents"), provider), "users");
      if (!usersRoot.isDirectory()) {
        continue;
      }
      var userDirs = usersRoot.listFiles();
      if (userDirs === null) {
        continue;
      }
      for (var userIndex = 0; userIndex < userDirs.length; userIndex++) {
        var userDir = userDirs[userIndex];
        var conversationsDir = new File(userDir, "conversations");
        if (!conversationsDir.isDirectory()) {
          continue;
        }
        var conversationDirs = conversationsDir.listFiles();
        if (conversationDirs === null) {
          continue;
        }
        for (var conversationIndex = 0; conversationIndex < conversationDirs.length; conversationIndex++) {
          var conversationDir = conversationDirs[conversationIndex];
          var record = readJsonFile(new File(conversationDir, "conversation.json"));
          if (record === null) {
            continue;
          }
          if (record.deleted === true || trim(record.status).toLowerCase() === "deleted") {
            references.tombstones.push({
              dir: conversationDir,
              updatedAt: Number(record.updatedAt || record.createdAt || conversationDir.lastModified() || 0)
            });
            continue;
          }
          var conversationId = trim(record.conversationId || record.threadid || conversationDir.getName());
          if (conversationId.length) {
            references.conversationIds[conversationId] = true;
          }
          var externalSessionId = trim(record.externalSessionId || record.codexThreadId || record.sessionId);
          if (externalSessionId.length) {
            references.sessionIds[externalSessionId] = true;
          }
          if ((provider === "codex" || provider === "claude") && conversationId.length) {
            var expected = new File(
              new File(
                new File(
                  new File(
                    new File(workspaceRoot, "agents/" + provider),
                    "homes/users"
                  ),
                  userDir.getName()
                ),
                "conversations"
              ),
              stableId("conversation", conversationId)
            );
            addProtectedHome(references.homePaths, expected);
          }
          addProtectedHome(references.homePaths, record.codexHome || record.claudeHome || record.agentHome || "");
        }
      }
    }

    var registry = getRegistry();
    var iterator = registry.keySet().iterator();
    while (iterator.hasNext()) {
      var handle = String(iterator.next());
      var entry = registry.get(handle);
      if (entry && processAlive(entry.process)) {
        references.conversationIds[trim(entry.conversationId || handle)] = true;
        if (entry.home && entry.home.path) {
          addProtectedHome(references.homePaths, entry.home.path);
        }
      }
    }

    var pidProviders = ["codex", "claude"];
    for (var pidProviderIndex = 0; pidProviderIndex < pidProviders.length; pidProviderIndex++) {
      var pidDir = providerPidRegistryDir(workspaceRoot, pidProviders[pidProviderIndex]);
      if (pidDir === null || !pidDir.isDirectory()) {
        continue;
      }
      var pidFiles = pidDir.listFiles();
      if (pidFiles === null) {
        continue;
      }
      for (var pidIndex = 0; pidIndex < pidFiles.length; pidIndex++) {
        var pidFile = pidFiles[pidIndex];
        var pidRecord = readJsonFile(pidFile);
        var pid = pidRecord === null ? 0 : Number(pidRecord.pid || 0);
        if (pid > 0 && processHandleAlive(pid)) {
          references.conversationIds[trim(pidRecord.handle)] = true;
          addProtectedHome(references.homePaths, pidRecord.codexHome || "");
        } else {
          try { pidFile["delete"](); } catch (_ignoreDeadCleanupPidFile) {}
        }
      }
    }
    return references;
  }

  function cleanupConversationArtifacts(options, report) {
    var workspaceRoot = resolveWorkspaceRoot(options);
    var conversationId = trim(options.conversationId || options.threadid || options.handle);
    var handle = trim(options.handle || conversationId);
    var externalSessionId = trim(options.externalSessionId || options.codexThreadId || options.sessionId);
    var registry = getRegistry();
    var entry = handle.length ? registry.get(handle) : null;
    if (entry !== null && typeof entry !== "undefined") {
      stopEntry(entry, true);
    }

    if (handle.length) {
      var pidFile = codexPidFile(workspaceRoot, handle);
      if (pidFile !== null && pidFile.isFile()) {
        var pidRecord = readJsonFile(pidFile);
        var pid = pidRecord === null ? 0 : Number(pidRecord.pid || 0);
        if (pid > 0 && processHandleAlive(pid)) {
          destroyPidTree(pid);
        }
        deleteDirectoryTree(pidFile, report.removed, report.errors);
      }
    }

    var leaseFile = viewerDebugPortLeaseFile({
      workspaceRoot: workspaceRoot,
      conversationId: conversationId
    });
    if (leaseFile !== null) {
      deleteDirectoryTree(leaseFile, report.removed, report.errors);
    }

    var userSlugs = {};
    var hasUserSlug = false;
    var userId = trim(options.userId);
    if (userId.length) {
      userSlugs[userPathSlug(userId)] = true;
      hasUserSlug = true;
    }
    var explicitUserKey = trim(options.userKey);
    if (explicitUserKey.length) {
      userSlugs[safePathPart(explicitUserKey)] = true;
      hasUserSlug = true;
    }
    if (!hasUserSlug) {
      userSlugs.studio = true;
    }
    var sessionIds = {};
    if (externalSessionId.length) {
      sessionIds[externalSessionId] = true;
    }

    for (var userSlug in userSlugs) {
      if (!Object.prototype.hasOwnProperty.call(userSlugs, userSlug)) {
        continue;
      }
      var conversationsRoot = new File(
        new File(
          new File(
            new File(workspaceRoot, "agents/codex"),
            "homes/users"
          ),
          userSlug
        ),
        "conversations"
      );
      if (!conversationsRoot.isDirectory()) {
        continue;
      }
      var homes = conversationsRoot.listFiles();
      if (homes === null) {
        continue;
      }
      var expectedName = conversationId.length ? stableId("conversation", conversationId) : "";
      for (var homeIndex = 0; homeIndex < homes.length; homeIndex++) {
        var home = homes[homeIndex];
        var matchesConversation = expectedName.length && String(home.getName()) === expectedName;
        var matchesSession = externalSessionId.length && homeContainsReferencedSession(home, sessionIds, 0);
        if (matchesConversation || matchesSession) {
          deleteDirectoryTree(home, report.removed, report.errors);
        }
      }
      removeDirectoryWhenEmpty(conversationsRoot, report.removed);
    }
  }

  function cleanupOrphanedAgentStorage(options, report) {
    var workspaceRoot = resolveWorkspaceRoot(options);
    var current = now();
    var graceMs = intValue(
      options.orphanGraceSeconds,
      Math.floor(DEFAULT_STORAGE_ORPHAN_GRACE_MS / 1000),
      300,
      2592000
    ) * 1000;
    var references = activeAgentStorageReferences(workspaceRoot);
    var homesUsersRoot = new File(
      new File(
        new File(
          new File(workspaceRoot, "agents"),
          "codex"
        ),
        "homes"
      ),
      "users"
    );
    if (homesUsersRoot.isDirectory()) {
      var users = homesUsersRoot.listFiles();
      if (users !== null) {
        for (var userIndex = 0; userIndex < users.length; userIndex++) {
          var conversationsRoot = new File(users[userIndex], "conversations");
          if (!conversationsRoot.isDirectory()) {
            continue;
          }
          var homes = conversationsRoot.listFiles();
          if (homes === null) {
            continue;
          }
          for (var homeIndex = 0; homeIndex < homes.length; homeIndex++) {
            var home = homes[homeIndex];
            var homePath = canonicalFilePath(home);
            var protectedHome = references.homePaths[homePath] === true ||
              homeContainsReferencedSession(home, references.sessionIds, 0);
            var age = current - Number(home.lastModified() || 0);
            if (!protectedHome && age >= graceMs) {
              deleteDirectoryTree(home, report.removed, report.errors);
            } else {
              report.kept.push({
                path: filePath(home),
                reason: protectedHome ? "referenced" : "grace",
                ageMs: age
              });
            }
          }
          removeDirectoryWhenEmpty(conversationsRoot, report.removed);
        }
      }
    }

    for (var tombstoneIndex = 0; tombstoneIndex < references.tombstones.length; tombstoneIndex++) {
      var tombstone = references.tombstones[tombstoneIndex];
      if (current - tombstone.updatedAt >= graceMs) {
        deleteDirectoryTree(tombstone.dir, report.removed, report.errors);
      }
    }

    var leasesDir = new File(new File(new File(workspaceRoot, "agents"), "codex"), "viewer-debug-ports");
    if (leasesDir.isDirectory()) {
      var leases = leasesDir.listFiles();
      if (leases !== null) {
        for (var leaseIndex = 0; leaseIndex < leases.length; leaseIndex++) {
          var leaseFile = leases[leaseIndex];
          var lease = readJsonFile(leaseFile);
          var leaseConversationId = trim(lease && lease.conversationId);
          var leaseAge = current - Number((lease && lease.createdAt) || leaseFile.lastModified() || 0);
          if (references.conversationIds[leaseConversationId] !== true && leaseAge >= graceMs) {
            deleteDirectoryTree(leaseFile, report.removed, report.errors);
          }
        }
      }
      removeDirectoryWhenEmpty(leasesDir, report.removed);
    }
  }

  C8O.agentBridge.cleanupStorage = function (options) {
    options = optionsWithRequestFallbacks(options || {});
    var workspaceRoot = resolveWorkspaceRoot(options);
    var report = {
      ok: true,
      status: "cleaned",
      workspaceRoot: workspaceRoot,
      removed: [],
      kept: [],
      errors: [],
      timestamp: now()
    };
    var exactConversation = trim(options.conversationId || options.threadid || options.handle).length > 0;
    var force = boolValue(options.force, exactConversation);
    var intervalMs = intValue(
      options.intervalSeconds,
      Math.floor(DEFAULT_STORAGE_CLEANUP_INTERVAL_MS / 1000),
      300,
      2592000
    ) * 1000;
    var marker = new File(new File(new File(workspaceRoot, "agents"), "codex"), STORAGE_CLEANUP_FILE);
    if (!exactConversation && !force) {
      var markerState = readJsonFile(marker);
      var nextCleanupAt = markerState === null ? 0 : Number(markerState.nextCleanupAt || 0);
      if (nextCleanupAt > report.timestamp) {
        report.status = "skipped";
        report.nextCleanupAt = nextCleanupAt;
        return report;
      }
    }
    if (exactConversation) {
      cleanupConversationArtifacts(options, report);
    } else {
      cleanupOrphanedAgentStorage(options, report);
      try {
        writeJsonFile(marker, {
          lastCleanupAt: report.timestamp,
          nextCleanupAt: report.timestamp + intervalMs,
          removedCount: report.removed.length,
          errorCount: report.errors.length
        });
        report.nextCleanupAt = report.timestamp + intervalMs;
      } catch (markerError) {
        report.errors.push({ path: filePath(marker), error: String(markerError) });
      }
    }
    report.ok = report.errors.length === 0;
    report.status = report.ok ? "cleaned" : "partial";
    return report;
  };

  C8O.agentBridge.settings = function (options) {
    options = optionsWithRequestFallbacks(options);
    var presenceOnly = boolValue(options.runtimePresenceOnly, false);
    var rawProvider = trim(options.provider || options.agent || "").toLowerCase();
    var provider = (!rawProvider.length || rawProvider === "all" || rawProvider === "*" || rawProvider === "any") ? "" : normalizeProvider(rawProvider);
    var providers = [];
    // The Convertigo mode comes first: it is the zero-configuration default.
    if (!provider.length || provider === "convertigo") {
      providers.push(vibeSettings(withVibeProfile(options, "convertigo")));
    }
    if (!provider.length || provider === "codex") {
      providers.push(codexSettings(options));
    }
    if (!provider.length || provider === "vibe") {
      providers.push(vibeSettings(withVibeProfile(options, "mistral")));
    }
    if ((!provider.length || provider === "claude") && typeof claudeSettings === "function") {
      providers.push(claudeSettings(options));
    }
    var settingsWorkspaceRoot = trim(options.workspaceRoot);
    if (!settingsWorkspaceRoot.length) {
      for (var workspaceIndex = 0; workspaceIndex < providers.length; workspaceIndex++) {
        settingsWorkspaceRoot = trim(providers[workspaceIndex] && providers[workspaceIndex].setup && providers[workspaceIndex].setup.workspaceRoot);
        if (settingsWorkspaceRoot.length) {
          break;
        }
      }
    }
    var settingsCacheMaxAgeMs = intValue(options.settingsCacheMaxAgeMs || options.updateCheckCacheMs, DEFAULT_RUNTIME_UPDATE_CACHE_MS, 60000, 604800000);
    for (var cachedProviderIndex = 0; cachedProviderIndex < providers.length; cachedProviderIndex++) {
      var currentProvider = providers[cachedProviderIndex];
      var vibeFamily = normalizeProvider(currentProvider.id) === "vibe" || normalizeProvider(currentProvider.id) === "convertigo";
      currentProvider = hydrateProviderSettingsFromCache(settingsWorkspaceRoot, currentProvider, vibeFamily);
      if (presenceOnly) {
        currentProvider = requireCachedProviderConfiguration(currentProvider);
      }
      currentProvider = requireProviderAuthentication(currentProvider);
      if (!presenceOnly && vibeFamily && currentProvider.ready === true && typeof C8O.agentBridge.discoverVibeSettings === "function") {
        var refreshProviderSettings = boolValue(options.refreshProviderSettings || options.refreshModelCatalog || options.refreshUpdateCheck, false);
        if (refreshProviderSettings || !providerSettingsCacheFresh(currentProvider, settingsCacheMaxAgeMs)) {
          currentProvider = C8O.agentBridge.discoverVibeSettings(withVibeProfile(options, currentProvider.profile || (normalizeProvider(currentProvider.id) === "convertigo" ? "convertigo" : "mistral")), currentProvider);
        }
      }
      providers[cachedProviderIndex] = requireProviderAuthentication(currentProvider);
    }
    if (!presenceOnly) {
      writePersistentProviderSettingsCache(settingsWorkspaceRoot, providers);
    }
    if (boolValue(options.savePreferences, false)) {
      var requestedPreferences = validatedAgentPreferences({
        confirmed: true,
        provider: options.provider || options.agent || options.agentProvider,
        model: options.model,
        reasoning: options.reasoningEffort || options.reasoningLevel,
        serviceTier: options.serviceTier,
        updatedAt: now()
      }, providers);
      if (requestedPreferences !== null) {
        writePersistentAgentPreferences(settingsWorkspaceRoot, options, requestedPreferences);
      }
    }
    var preferences = validatedAgentPreferences(readPersistentAgentPreferences(settingsWorkspaceRoot, options), providers);
    var defaultProvider = null;
    for (var i = 0; i < providers.length; i++) {
      if (providers[i].ready === true) {
        defaultProvider = providers[i];
        break;
      }
    }
    var defaults = {
      provider: defaultProvider !== null ? defaultProvider.id : "",
      model: defaultProvider !== null ? defaultProvider.defaultModel : "",
      reasoning: ""
    };
    if (defaultProvider !== null) {
      defaults.reasoning = providerDefaultReasoning(defaultProvider);
    }
    if (preferences !== null && preferences.confirmed === true) {
      defaults.provider = preferences.provider;
      defaults.model = preferences.model;
      defaults.reasoning = preferences.reasoning;
    }
    var storageCleanup = C8O.agentBridge.cleanupStorage({
      workspaceRoot: settingsWorkspaceRoot
    });
    return {
      ok: providers.length > 0,
      status: providers.length ? "ready" : "empty",
      agentProfile: publicAgentCapabilityProfile(options),
      agentProfiles: publicAgentCapabilityProfiles(),
      defaults: defaults,
      preferences: preferences,
      providers: providers,
      storageCleanup: {
        status: storageCleanup.status,
        removedCount: storageCleanup.removed.length,
        errorCount: storageCleanup.errors.length,
        nextCleanupAt: storageCleanup.nextCleanupAt || 0
      },
      timestamp: now()
    };
  };

  function envKeys(env) {
    var keys = [];
    for (var key in env) {
      if (Object.prototype.hasOwnProperty.call(env, key)) {
        keys.push(String(key));
      }
    }
    keys.sort();
    return keys;
  }

  function normalizeCredentialsPolicy(value) {
    var policy = trim(value).toLowerCase();
    if (!policy.length) {
      return "explicit";
    }
    if (policy === "user" || policy === "home" || policy === "user_home" || policy === "userhome") {
      return "user-home";
    }
    if (policy === "vibe" || policy === "vibe_home" || policy === "vibehome") {
      return "vibe-home";
    }
    if (policy === "none" || policy === "off") {
      return "explicit";
    }
    if (policy === "explicit" || policy === "user-home" || policy === "vibe-home" || policy === "auto") {
      return policy;
    }
    return "explicit";
  }

  function mergeEnvFile(env, file, sourceName) {
    var parsed = readEnvFile(file);
    var source = {
      source: sourceName,
      path: parsed.path,
      exists: parsed.exists,
      keys: parsed.keys,
      injectedKeys: []
    };
    for (var i = 0; i < parsed.keys.length; i++) {
      var key = parsed.keys[i];
      if (!Object.prototype.hasOwnProperty.call(env, key) || env[key] === null || typeof env[key] === "undefined" || String(env[key]).length === 0) {
        env[key] = parsed.values[key];
        source.injectedKeys.push(key);
      }
    }
    return source;
  }

  function applyCredentialsPolicy(env, options, vibeHome) {
    var policy = normalizeCredentialsPolicy(options.credentialsPolicy || options.envPolicy);
    var report = {
      policy: policy,
      sources: [],
      injectedKeys: []
    };
    var userHome = String(System.getProperty("user.home"));
    if (policy === "vibe-home" || policy === "auto") {
      report.sources.push(mergeEnvFile(env, new File(vibeHome, ".env"), "vibe-home"));
    }
    if (policy === "user-home" || policy === "auto") {
      report.sources.push(mergeEnvFile(env, new File(new File(userHome, ".vibe"), ".env"), "user-home"));
    }
    var collected = {};
    for (var i = 0; i < report.sources.length; i++) {
      var injected = report.sources[i].injectedKeys || [];
      for (var j = 0; j < injected.length; j++) {
        collected[injected[j]] = true;
      }
    }
    for (var key in collected) {
      if (Object.prototype.hasOwnProperty.call(collected, key)) {
        report.injectedKeys.push(key);
      }
    }
    report.injectedKeys.sort();
    return report;
  }

  function publicHomeInfo(home) {
    home = home || {};
    return {
      scope: home.scope || "",
      path: home.path || "",
      explicit: home.explicit === true,
      userIdSet: !!trim(home.userId),
      conversationId: home.conversationId || "",
      projectId: home.projectId || "",
      error: home.error || ""
    };
  }

  function createEntry(handle, provider, protocol, command, cwd, env, ttlMillis, home, credentials, model) {
    return {
      handle: handle,
      provider: normalizeProvider(provider),
      model: trim(model),
      protocol: protocol || "acp",
      command: command.slice(0),
      cwd: cwd,
      envKeys: envKeys(env),
      home: publicHomeInfo(home),
      credentials: credentials || { policy: "explicit", sources: [], injectedKeys: [] },
      process: null,
      pid: 0,
      pidFile: "",
      workspaceRoot: "",
      writer: null,
      stdoutThread: null,
      stderrThread: null,
      codexSessionWatcherThread: null,
      codexSessionFile: "",
      codexSessionFileLineCount: 0,
      codexSessionWatchStartedAt: 0,
      codexSeenLineKeys: {},
      codexSeenLineOrder: [],
      events: Collections.synchronizedList(new ArrayList()),
      firstIndex: 0,
      nextIndex: 0,
      nextRequestId: 1,
      pending: new ConcurrentHashMap(),
      createdAt: now(),
      lastAccess: now(),
      ttlMillis: ttlMillis,
      status: "starting",
      phase: "spawn",
      sessionId: "",
      codexThreadId: "",
      codexRuntimeMode: "",
      activeTurnId: "",
      init: null,
      session: null,
      configOptions: [],
      providerSettings: null,
      lastError: "",
      lastCodexProgressMessage: "",
      lastCodexAnswerChunk: "",
      codexTurnEnded: false,
      closedAt: 0
    };
  }

  function pushEvent(entry, type, data) {
    var event = {
      index: entry.nextIndex++,
      at: now(),
      type: String(type),
      data: data || {}
    };
    // Every provider reports its turns with these three events: keep a common "turn running"
    // flag so interrupt() needs no provider-specific state.
    if (event.type === "turn/start") {
      entry.turnActive = true;
    } else if (event.type === "turn/end" || event.type === "turn/error" || event.type === "system/closed") {
      entry.turnActive = false;
    }
    entry.events.add(event);
    while (entry.events.size() > MAX_EVENT_BUFFER) {
      entry.events.remove(0);
      entry.firstIndex++;
    }
    entry.lastAccess = now();
    return event;
  }

  // Browser login helpers shared by the resident providers ------------------

  var AGENT_LOGIN_REGISTRY_KEY = "lib_ConvertigoAgentBridge.agentLoginRegistry.v1";
  var AGENT_LOGIN_TIMEOUT_MS = 15 * 60 * 1000;

  function providerLoginRegistry() {
    var store = getServerStore();
    if (store !== null) {
      var registry = store.get(AGENT_LOGIN_REGISTRY_KEY);
      if (registry === null || typeof registry === "undefined") {
        registry = new ConcurrentHashMap();
        store.set(AGENT_LOGIN_REGISTRY_KEY, registry);
      }
      return registry;
    }
    if (!C8O.agentBridge._fallbackAgentLoginRegistry) {
      C8O.agentBridge._fallbackAgentLoginRegistry = new ConcurrentHashMap();
    }
    return C8O.agentBridge._fallbackAgentLoginRegistry;
  }

  function loginProcessOutput(entry) {
    var output = "";
    try { output += readTextFile(entry.stdoutFile); } catch (_ignoreLoginOut) {}
    try { output += "\n" + readTextFile(entry.stderrFile); } catch (_ignoreLoginErr) {}
    output = output.replace(/(access_token|refresh_token|id_token|api_key|apikey)\s*[:=]\s*[^\s]+/gi, "$1=<redacted>");
    if (output.length > 8000) {
      output = "... " + output.substring(output.length - 8000);
    }
    return output;
  }

  function loginProcessUrl(output) {
    var match = String(output || "").match(/https:\/\/[^\s<>'\"\u001b]+/i);
    return match ? match[0].replace(/[),.;]+$/, "") : "";
  }

  function loginProcessExitCode(entry, alive) {
    if (alive) {
      return -1;
    }
    try { return Number(entry.process.exitValue()); } catch (_ignoreLoginExit) {}
    return -1;
  }

  function expireLoginProcess(entry, timeoutMs) {
    var limit = intValue(timeoutMs, AGENT_LOGIN_TIMEOUT_MS, 60000, 3600000);
    if (processAlive(entry.process) && (now() - Number(entry.startedAt || 0)) > limit) {
      try { entry.process.destroy(); } catch (_ignoreLoginTimeoutDestroy) {}
      entry.timedOut = true;
      return true;
    }
    return entry.timedOut === true;
  }

  function isMacOsHost() {
    try {
      return String(System.getProperty("os.name") || "").toLowerCase().indexOf("mac") !== -1;
    } catch (_ignoreOsName) {
      return false;
    }
  }

  function processAlive(process) {
    if (process === null || typeof process === "undefined") {
      return false;
    }
    try {
      return process.isAlive();
    } catch (_ignoreIsAlive) {
      try {
        process.exitValue();
        return false;
      } catch (_notExited) {
        return true;
      }
    }
  }

  function processPid(process) {
    try {
      if (process !== null && typeof process !== "undefined" && process.pid) {
        return Number(process.pid());
      }
    } catch (_ignoreProcessPid) {}
    return 0;
  }

  function processHandleForPid(pid) {
    var numericPid = Number(pid || 0);
    if (!numericPid) {
      return null;
    }
    try {
      var optional = ProcessHandle.of(java.lang.Long.valueOf(String(Math.floor(numericPid))));
      if (optional !== null && optional.isPresent()) {
        return optional.get();
      }
    } catch (_ignoreProcessHandleForPid) {}
    return null;
  }

  function processHandleAlive(pid) {
    var handle = processHandleForPid(pid);
    if (handle === null) {
      return false;
    }
    try {
      return handle.isAlive();
    } catch (_ignoreProcessHandleAlive) {
      return false;
    }
  }

  function destroyProcessHandle(handle, force) {
    if (handle === null) {
      return false;
    }
    try {
      if (force === true) {
        return handle.destroyForcibly();
      }
      return handle.destroy();
    } catch (_ignoreDestroyProcessHandle) {
      return false;
    }
  }

  function destroyPidTree(pid) {
    var handle = processHandleForPid(pid);
    if (handle === null) {
      return false;
    }
    var descendants = new ArrayList();
    try {
      var iterator = handle.descendants().iterator();
      while (iterator.hasNext()) {
        descendants.add(iterator.next());
      }
    } catch (_ignoreDescendants) {}
    for (var i = descendants.size() - 1; i >= 0; i--) {
      destroyProcessHandle(descendants.get(i), false);
    }
    destroyProcessHandle(handle, false);
    try {
      Thread.sleep(500);
    } catch (_ignoreDestroySleep) {}
    for (var j = descendants.size() - 1; j >= 0; j--) {
      var child = descendants.get(j);
      try {
        if (child.isAlive()) {
          destroyProcessHandle(child, true);
        }
      } catch (_ignoreForceChild) {}
    }
    try {
      if (handle.isAlive()) {
        destroyProcessHandle(handle, true);
      }
    } catch (_ignoreForceHandle) {}
    return true;
  }

  function codexPidRegistryDir(workspaceRoot) {
    return providerPidRegistryDir(workspaceRoot, "codex");
  }

  function providerPidRegistryDir(workspaceRoot, provider) {
    var root = trim(workspaceRoot);
    if (!root.length) {
      root = engineWorkspaceRoot();
    }
    if (!root.length) {
      return null;
    }
    var providerDir = normalizeProvider(provider || "codex");
    return new File(new File(new File(root, "agents"), providerDir), "app-server-pids");
  }

  function codexPidFile(workspaceRoot, handle) {
    return providerPidFile(workspaceRoot, "codex", handle);
  }

  function providerPidFile(workspaceRoot, provider, handle) {
    var dir = providerPidRegistryDir(workspaceRoot, provider);
    if (dir === null) {
      return null;
    }
    return new File(dir, safePathPart(handle) + ".json");
  }

  // ---------------------------------------------------------------------------------------
  // Agent process lifecycle, common to every provider.
  //
  // A child of ProcessBuilder outlives its JVM unless something stops it. Four layers, all
  // applied in startProcess() so that a new provider inherits them with no specific code:
  //   1. a PID file per running agent, carrying the owner JVM pid and the Bridge version;
  //   2. a sweep of every provider's PID files before each launch: agents whose owner JVM is
  //      gone, or that were started by another Bridge version, are stopped at once;
  //   3. a JVM shutdown hook that stops every registered agent on a normal exit;
  //   4. a guard process around the agent that stops it when the owner JVM disappears
  //      (kill -9, crash), which no in-JVM mechanism can cover.
  // ---------------------------------------------------------------------------------------
  function entryUsesPidTree(entry) {
    return !!entry && entry.process !== null && typeof entry.process !== "undefined";
  }

  function currentJvmPid() {
    try {
      return Number(ProcessHandle.current().pid());
    } catch (_ignoreCurrentPid) {
      return 0;
    }
  }

  function bridgeProjectVersion() {
    try {
      return trim(String(context.project.getVersion()));
    } catch (_ignoreBridgeVersion) {
      return "";
    }
  }

  function forceDestroyPidTree(pid) {
    var handle = processHandleForPid(pid);
    if (handle === null) {
      return false;
    }
    try {
      var iterator = handle.descendants().iterator();
      while (iterator.hasNext()) {
        destroyProcessHandle(iterator.next(), true);
      }
    } catch (_ignoreForceDescendants) {}
    return destroyProcessHandle(handle, true);
  }

  var SHUTDOWN_HOOK_PROPERTY = "convertigo.agentbridge.shutdownHook";

  function ensureAgentShutdownHook() {
    try {
      if (String(System.getProperty(SHUTDOWN_HOOK_PROPERTY)) === "installed") {
        return false;
      }
      var registry = getRegistry();
      var hook = new java.lang.Thread(new java.lang.Runnable({
        run: function () {
          try {
            var keys = registry.keySet().toArray();
            for (var i = 0; i < keys.length; i++) {
              try {
                var entry = registry.get(keys[i]);
                var pid = entry ? Number(entry.pid || 0) : 0;
                if (pid > 0) {
                  forceDestroyPidTree(pid);
                } else if (entry && entry.process) {
                  entry.process.destroyForcibly();
                }
                if (entry && entry.pidFile) { new File(String(entry.pidFile))["delete"](); }
              } catch (_ignoreHookEntry) {}
            }
          } catch (_ignoreHook) {}
        }
      }), "convertigo-agent-bridge-shutdown");
      java.lang.Runtime.getRuntime().addShutdownHook(hook);
      System.setProperty(SHUTDOWN_HOOK_PROPERTY, "installed");
      return true;
    } catch (_ignoreShutdownHook) {
      return false;
    }
  }

  // The guard is a provider-agnostic Node script: `node agent-guard.cjs <ownerPid> -- <command>`.
  // It shares its stdio with the agent, so the JSON streams are not proxied.
  var AGENT_GUARD_VERSION = "1";
  var AGENT_GUARD_SOURCE = [
    "// Generated by lib_ConvertigoAgentBridge. Stops the agent when its owner process disappears.",
    "const { spawn, spawnSync } = require('child_process');",
    "const owner = Number(process.argv[2]);",
    "const split = process.argv.indexOf('--');",
    "const command = process.argv[split + 1];",
    "const args = process.argv.slice(split + 2);",
    "const windows = process.platform === 'win32';",
    "const startedUnder = process.ppid;",
    "const child = spawn(command, args, { stdio: 'inherit', windowsHide: true, detached: !windows });",
    "let stopping = false;",
    "function stopChild() {",
    "  if (stopping) { return; }",
    "  stopping = true;",
    "  try {",
    "    if (windows) { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); }",
    "    else { try { process.kill(-child.pid, 'SIGTERM'); } catch (e) { child.kill('SIGTERM'); } }",
    "  } catch (e) {}",
    "  setTimeout(() => {",
    "    try { if (!windows) { process.kill(-child.pid, 'SIGKILL'); } } catch (e) {}",
    "    process.exit(143);",
    "  }, 1500).unref();",
    "}",
    "function ownerAlive() {",
    "  if (!windows && process.ppid !== startedUnder) { return false; }",
    "  if (!(owner > 0)) { return true; }",
    "  try { process.kill(owner, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }",
    "}",
    "const watch = setInterval(() => { if (!ownerAlive()) { clearInterval(watch); stopChild(); } }, 2000);",
    "child.on('exit', (code, signal) => { clearInterval(watch); process.exit(code === null ? (signal ? 143 : 1) : code); });",
    "child.on('error', () => { clearInterval(watch); process.exit(127); });",
    "['SIGTERM', 'SIGINT', 'SIGHUP'].forEach(name => { try { process.on(name, stopChild); } catch (e) {} });",
    ""
  ].join("\n");

  function agentGuardEnabled(options) {
    var explicit = trim(options && (options.agentProcessGuard || options.processGuard));
    if (explicit.length) {
      return boolValue(explicit, true);
    }
    try {
      var symbol = Packages.com.twinsoft.convertigo.engine.Engine.theApp.databaseObjectsManager.symbolsGetValue("agentbridge.process.guard");
      if (symbol !== null && typeof symbol !== "undefined" && trim(String(symbol)).length) {
        return boolValue(String(symbol), true);
      }
    } catch (_ignoreGuardSymbol) {}
    return true;
  }

  // Returns the command to launch, guarded when possible. `reason` explains a missing guard so
  // the caller can warn: a provider without guard leaks its agent when the JVM is killed.
  function agentGuardedCommand(entry, options) {
    var command = entry.command || [];
    if (!agentGuardEnabled(options || entry.options || {})) {
      return { command: command, guarded: false, reason: "disabled" };
    }
    var executable = trim(command[0]).toLowerCase();
    if (isWindows() && (/\.(cmd|bat)$/).test(executable)) {
      // Node refuses to spawn .cmd/.bat without a shell; quoting a JSON-RPC agent command
      // through cmd.exe is not worth the risk.
      return { command: command, guarded: false, reason: "windows_script_command" };
    }
    var node = null;
    try { node = detectNodeRuntime(options || entry.options || {}); } catch (_ignoreGuardNode) {}
    if (!node || !node.found) {
      return { command: command, guarded: false, reason: "node_runtime_missing" };
    }
    var ownerPid = currentJvmPid();
    if (!ownerPid) {
      return { command: command, guarded: false, reason: "owner_pid_unknown" };
    }
    try {
      var root = trim(entry.workspaceRoot) || engineWorkspaceRoot();
      var script = new File(new File(new File(root, "agents"), "guard"), "agent-guard-v" + AGENT_GUARD_VERSION + ".cjs");
      if (!script.isFile() || String(readTextFile(script)) !== AGENT_GUARD_SOURCE) {
        ensureDirectory(script.getParentFile());
        writeTextFile(script, AGENT_GUARD_SOURCE);
      }
      return { command: [node.path, filePath(script), String(ownerPid), "--"].concat(command), guarded: true, reason: "" };
    } catch (guardError) {
      return { command: command, guarded: false, reason: "guard_script_error: " + String(guardError) };
    }
  }

  // Decides what to do with a live agent found through its PID file.
  function pidRecordVerdict(record, state) {
    record = record || {};
    if (state.registered) {
      return { stop: false, reason: "registered" };
    }
    var ownerPid = Number(record.ownerPid || 0);
    if (ownerPid > 0 && ownerPid !== Number(state.currentPid || 0)) {
      // Started by another JVM: stop it only once that JVM is gone.
      return state.ownerAlive ? { stop: false, reason: "other_owner" } : { stop: true, reason: "owner_gone" };
    }
    var recorded = trim(record.bridgeVersion), running = trim(state.bridgeVersion);
    if (recorded.length && running.length && recorded !== running) {
      return { stop: true, reason: "bridge_version_changed" };
    }
    // Ours (or a record older than the owner field) but no longer registered: idle rule.
    return state.maxIdleMs <= 0 || state.idleMs > state.maxIdleMs ? { stop: true, reason: "orphan" } : { stop: false, reason: "grace" };
  }

  // Provider-agnostic sweep: every agents/<provider>/app-server-pids directory.
  function sweepAllProviderPidFiles(workspaceRoot, maxIdleMs) {
    var result = { stopped: [], kept: [] };
    try {
      var root = trim(workspaceRoot) || engineWorkspaceRoot();
      var agents = new File(root, "agents");
      var providers = agents.isDirectory() ? agents.listFiles() : null;
      for (var i = 0; providers !== null && i < providers.length; i++) {
        if (!providers[i].isDirectory() || !new File(providers[i], "app-server-pids").isDirectory()) {
          continue;
        }
        var swept = sweepProviderPidFiles(root, String(providers[i].getName()), maxIdleMs);
        result.stopped = result.stopped.concat(swept.stopped);
        result.kept = result.kept.concat(swept.kept);
      }
    } catch (_ignoreSweepAll) {}
    return result;
  }

  function registryContainsPid(pid) {
    var registry = getRegistry();
    var iterator = registry.keySet().iterator();
    while (iterator.hasNext()) {
      var key = String(iterator.next());
      var entry = registry.get(key);
      if (entry && Number(entry.pid || 0) === Number(pid || 0) && processAlive(entry.process)) {
        return true;
      }
    }
    return false;
  }

  function writeEntryPidFile(entry) {
    if (!entryUsesPidTree(entry)) {
      return;
    }
    var pid = processPid(entry.process);
    if (!pid) {
      return;
    }
    entry.pid = pid;
    if (!trim(entry.pidFile).length) {
      var file = providerPidFile(entry.workspaceRoot || "", entry.provider, entry.handle);
      entry.pidFile = file === null ? "" : filePath(file);
    }
    if (!trim(entry.pidFile).length) {
      return;
    }
    writeJsonFile(new File(entry.pidFile), {
      provider: entry.provider,
      protocol: entry.protocol,
      handle: entry.handle,
      pid: pid,
      command: entry.command,
      cwd: entry.cwd,
      workspaceRoot: entry.workspaceRoot || "",
      codexHome: entry.home && entry.home.path ? entry.home.path : "",
      ownerPid: currentJvmPid(),
      bridgeVersion: bridgeProjectVersion(),
      guarded: entry.guarded === true,
      createdAt: entry.createdAt,
      lastAccess: entry.lastAccess,
      ttlMs: entry.ttlMillis
    });
  }

  function deleteEntryPidFile(entry) {
    try {
      if (entry && trim(entry.pidFile).length) {
        new File(entry.pidFile)["delete"]();
      }
    } catch (_ignoreDeleteEntryPidFile) {}
  }

  function sweepCodexAppServerPidFiles(workspaceRoot, maxIdleMs) {
    return sweepProviderPidFiles(workspaceRoot, "codex", maxIdleMs);
  }

  function sweepProviderPidFiles(workspaceRoot, provider, maxIdleMs) {
    var dir = providerPidRegistryDir(workspaceRoot, provider);
    var result = { stopped: [], kept: [] };
    if (dir === null || !dir.isDirectory()) {
      return result;
    }
    var files = dir.listFiles();
    if (files === null) {
      return result;
    }
    var current = now();
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      if (!file.isFile() || String(file.getName()).indexOf(".json") === -1) {
        continue;
      }
      var record = readJsonFile(file);
      var pid = record ? Number(record.pid || 0) : 0;
      if (!pid || !processHandleAlive(pid)) {
        try { file["delete"](); } catch (_ignoreDeleteDeadPidFile) {}
        continue;
      }
      var lastAccess = Number(record.lastAccess || record.createdAt || file.lastModified() || 0);
      var ownerPid = Number(record.ownerPid || 0);
      var verdict = pidRecordVerdict(record, {
        registered: registryContainsPid(pid),
        currentPid: currentJvmPid(),
        ownerAlive: ownerPid > 0 && processHandleAlive(ownerPid),
        bridgeVersion: bridgeProjectVersion(),
        idleMs: current - lastAccess,
        maxIdleMs: maxIdleMs
      });
      if (verdict.stop) {
        destroyPidTree(pid);
        try { file["delete"](); } catch (_ignoreDeleteStoppedPidFile) {}
        result.stopped.push({ pid: pid, handle: record.handle || "", idleMs: current - lastAccess, reason: verdict.reason });
      } else {
        result.kept.push({ pid: pid, handle: record.handle || "", idleMs: current - lastAccess, reason: verdict.reason });
      }
    }
    return result;
  }

  function writeJson(entry, message) {
    if (entry && (entry.protocol === "codex-app-server" || entry.protocol === "claude-stream-json") && message && message.jsonrpc) {
      delete message.jsonrpc;
    }
    var text = JSON.stringify(message);
    entry.writer.write(text);
    entry.writer.newLine();
    entry.writer.flush();
  }

  function sendJsonResponse(entry, id, result) {
    try {
      writeJson(entry, {
        jsonrpc: "2.0",
        id: id,
        result: result || {}
      });
      pushEvent(entry, "acp/client_response", { id: id, result: result || {} });
    } catch (e) {
      entry.lastError = String(e);
      pushEvent(entry, "error", { message: String(e), phase: "client_response" });
    }
  }

  function sendJsonError(entry, id, code, message) {
    try {
      writeJson(entry, {
        jsonrpc: "2.0",
        id: id,
        error: {
          code: code,
          message: String(message)
        }
      });
    } catch (e) {
      entry.lastError = String(e);
    }
  }

  function choosePermissionOption(options) {
    if (!options || !options.length) {
      return "";
    }
    var first = "";
    var preferred = "";
    for (var i = 0; i < options.length; i++) {
      var option = options[i];
      var optionId = String(option.optionId || option.option_id || option.id || "");
      var name = String(option.name || "").toLowerCase();
      var kind = String(option.kind || "").toLowerCase();
      if (!first.length) {
        first = optionId;
      }
      if (optionId === "allow_once" || optionId === "allow") {
        return optionId;
      }
      if (!preferred.length && (kind.indexOf("allow") >= 0 || name.indexOf("allow") >= 0 || name.indexOf("approve") >= 0)) {
        preferred = optionId;
      }
    }
    return preferred || first;
  }

  function handleAgentRequest(entry, message) {
    var method = String(message.method || "");
    var params = message.params || {};
    pushEvent(entry, "acp/request_from_agent", { method: method, id: message.id || null, params: params });

    if (method === "session/request_permission") {
      var optionId = choosePermissionOption(params.options || []);
      if (optionId.length) {
        pushEvent(entry, "permission/selected", {
          optionId: optionId,
          toolCall: params.toolCall || params.tool_call || null
        });
        sendJsonResponse(entry, message.id, {
          outcome: {
            outcome: "selected",
            optionId: optionId
          }
        });
      } else {
        pushEvent(entry, "permission/cancelled", {
          toolCall: params.toolCall || params.tool_call || null
        });
        sendJsonResponse(entry, message.id, {
          outcome: {
            outcome: "cancelled"
          }
        });
      }
      return;
    }

    if (method === "fs/read_text_file" || method === "fs/write_text_file" || method.indexOf("terminal/") === 0) {
      sendJsonError(entry, message.id, -32601, "ACP client capability is disabled: " + method);
      return;
    }

    sendJsonError(entry, message.id, -32601, "Unsupported ACP client method: " + method);
  }

  function extractContentText(content) {
    if (content === null || typeof content === "undefined") {
      return "";
    }
    if (typeof content === "string") {
      return content;
    }
    if (typeof content.text !== "undefined") {
      return String(content.text);
    }
    if (content.content && typeof content.content.text !== "undefined") {
      return String(content.content.text);
    }
    try {
      return JSON.stringify(content);
    } catch (_ignoreStringify) {
      return String(content);
    }
  }

  function normalizeSessionUpdate(entry, params) {
    var update = params.update || params.sessionUpdate || params;
    var kind = String(update.sessionUpdate || update.session_update || "");
    var eventData = {
      sessionId: params.sessionId || params.session_id || entry.sessionId || "",
      update: update
    };

    if (kind === "agent_message_chunk") {
      eventData.text = extractContentText(update.content);
      pushEvent(entry, "answer/chunk", eventData);
      return;
    }
    if (kind === "agent_thought_chunk") {
      eventData.text = extractContentText(update.content);
      pushEvent(entry, "reasoning/chunk", eventData);
      return;
    }
    if (kind === "user_message_chunk") {
      eventData.text = extractContentText(update.content);
      pushEvent(entry, "user/chunk", eventData);
      return;
    }
    if (kind === "tool_call") {
      eventData.toolCallId = update.toolCallId || update.tool_call_id || "";
      eventData.title = update.title || "";
      eventData.status = update.status || "";
      pushEvent(entry, "tool/start", eventData);
      return;
    }
    if (kind === "tool_call_update") {
      eventData.toolCallId = update.toolCallId || update.tool_call_id || "";
      eventData.title = update.title || "";
      eventData.status = update.status || "";
      pushEvent(entry, "tool/update", eventData);
      return;
    }
    if (kind === "usage_update") {
      pushEvent(entry, "usage/update", eventData);
      return;
    }
    if (kind === "plan") {
      pushEvent(entry, "plan/update", eventData);
      return;
    }
    if (kind === "available_commands_update") {
      pushEvent(entry, "commands/update", eventData);
      return;
    }
    if (kind === "session_info_update") {
      pushEvent(entry, "session/update", eventData);
      return;
    }
    if (kind === "config_option_update") {
      var configOptions = update.configOptions || update.config_options || [];
      var providerSettings = updateVibeProviderSettings(entry, configOptions);
      pushEvent(entry, "config/update", {
        sessionId: eventData.sessionId,
        model: providerSettings && providerSettings.defaultModel || entry.model || "",
        reasoningEffort: providerSettings ? providerDefaultReasoning(providerSettings) : (entry.reasoningEffort || "")
      });
      return;
    }

    pushEvent(entry, "acp/session_update", eventData);
  }

  function handleAcpLine(entry, line, streamName) {
    var text = trim(line);
    if (!text.length) {
      return;
    }
    if (streamName !== "stdout" && streamName !== "codex-session") {
      pushEvent(entry, streamName, { line: text });
      return;
    }
    var message;
    try {
      message = JSON.parse(text);
    } catch (parseError) {
      pushEvent(entry, "stdout", { line: text });
      return;
    }

    if (typeof message.id !== "undefined" && (typeof message.result !== "undefined" || typeof message.error !== "undefined")) {
      var key = String(message.id);
      var pending = entry.pending.get(key);
      if (pending !== null && typeof pending !== "undefined") {
        pending.response = message;
        pending.done = true;
        pending.completedAt = now();
        if (pending.method === "session/prompt") {
          if (message.error) {
            pushEvent(entry, "turn/error", {
              requestId: message.id,
              method: pending.method,
              error: message.error
            });
          } else {
            pushEvent(entry, "turn/end", {
              requestId: message.id,
              method: pending.method,
              result: message.result || {}
            });
          }
        }
      }
      pushEvent(entry, message.error ? "acp/response_error" : "acp/response", {
        id: message.id,
        method: pending ? pending.method : "",
        response: message
      });
      return;
    }

    if (message.method) {
      if (String(message.method) === "session/update") {
        if (entry.replayingSession === true) {
          // session/load replays the stored history as updates: it is context being restored,
          // not a new answer, so it must not reach the conversation stream.
          entry.replayedUpdates = Number(entry.replayedUpdates || 0) + 1;
          return;
        }
        normalizeSessionUpdate(entry, message.params || {});
        return;
      }
      handleAgentRequest(entry, message);
      return;
    }

    pushEvent(entry, "acp/message", { message: message });
  }

  function handleProcessLine(entry, line, streamName) {
    if (entry.protocol === "codex-app-server") {
      handleCodexAppServerLine(entry, line, streamName);
      return;
    }
    if (entry.protocol === "claude-stream-json") {
      handleClaudeStreamLine(entry, line, streamName);
      return;
    }
    if (entry.protocol === "codex-jsonl") {
      handleCodexLine(entry, line, streamName);
      return;
    }
    handleAcpLine(entry, line, streamName);
  }

  function startReaderThread(entry, stream, streamName) {
    var reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8));
    var thread = new Thread(new Runnable({
      run: function () {
        try {
          var line;
          while ((line = reader.readLine()) !== null) {
            handleProcessLine(entry, String(line), streamName);
          }
        } catch (e) {
          if (entry.status !== "closed") {
            entry.lastError = String(e);
            pushEvent(entry, "error", { message: String(e), phase: streamName + "_reader" });
          }
        } finally {
          if (streamName === "stdout" && entry.status !== "closed" && entry.status !== "completed" && !processAlive(entry.process)) {
            entry.status = entry.status === "error" ? "error" : "exited";
            entry.closedAt = now();
            pushEvent(entry, "system/exit", {
              exitCode: getExitCode(entry.process)
            });
          }
        }
      }
    }), "lib_ConvertigoAgentBridge-" + streamName + "-" + entry.handle);
    thread.setDaemon(true);
    thread.start();
    return thread;
  }

  function getExitCode(process) {
    try {
      return process.exitValue();
    } catch (_ignoreExit) {
      return null;
    }
  }

  function sendAcpRequest(entry, method, params) {
    var id = entry.nextRequestId++;
    var pending = {
      id: id,
      method: method,
      startedAt: now(),
      done: false,
      response: null,
      completedAt: 0
    };
    entry.pending.put(String(id), pending);
    writeJson(entry, {
      jsonrpc: "2.0",
      id: id,
      method: method,
      params: params || {}
    });
    pushEvent(entry, "acp/request", { id: id, method: method });
    return pending;
  }

  function waitForPending(entry, pending, timeoutMs, removeWhenDone) {
    var deadline = now() + timeoutMs;
    while (now() < deadline) {
      if (pending.done === true) {
        if (removeWhenDone) {
          entry.pending.remove(String(pending.id));
        }
        if (pending.response && pending.response.error) {
          var message = pending.response.error.message || JSON.stringify(pending.response.error);
          var error = new Error(String(message));
          error.acpError = pending.response.error;
          error.method = pending.method;
          throw error;
        }
        return pending.response ? pending.response.result || {} : {};
      }
      if (!processAlive(entry.process)) {
        throw new Error(entry.provider + " process exited while waiting for " + pending.method);
      }
      Thread.sleep(50);
    }
    throw new Error("Timeout while waiting for ACP response: " + pending.method);
  }

  function acpRequest(entry, method, params, timeoutMs) {
    var pending = sendAcpRequest(entry, method, params);
    return waitForPending(entry, pending, timeoutMs, true);
  }

  function vibeImageBlocks(value, model) {
    var report = { blocks: [], skipped: [] };
    var paths = [];
    // Sequence variables reach Rhino as java.lang.String objects, not JS
    // strings: coerce everything that is not a JS array before parsing.
    if (value !== null && typeof value !== "undefined" && Object.prototype.toString.call(value) !== "[object Array]") {
      value = String(value);
    }
    var text = typeof value === "string" ? trim(value) : "";
    if (value && typeof value !== "string" && typeof value.length !== "undefined") {
      for (var v = 0; v < value.length; v++) {
        paths.push(String(value[v]));
      }
    } else if (text.indexOf("[") === 0) {
      paths = parseObject(text, []);
    } else if (text.length) {
      paths = text.split(/\s*[\n,;]\s*/);
    }
    var spec = vibeModelSpec(model);
    for (var i = 0; i < paths.length; i++) {
      var candidate = trim(paths[i] && paths[i].path ? paths[i].path : paths[i]);
      if (!candidate.length) {
        continue;
      }
      var file = new File(candidate);
      var lower = candidate.toLowerCase();
      var extension = lower.lastIndexOf(".") >= 0 ? lower.substring(lower.lastIndexOf(".") + 1) : "";
      var mimeType = VIBE_IMAGE_MIME_TYPES[extension] || "";
      if (!mimeType.length) {
        continue;
      }
      if (!file.isFile()) {
        report.skipped.push({ path: candidate, reason: "not_found" });
        continue;
      }
      if (spec.supportsImages !== true) {
        report.skipped.push({ path: candidate, reason: "model_without_vision", model: spec.activeModel });
        continue;
      }
      if (Number(file.length()) > VIBE_MAX_IMAGE_BYTES) {
        report.skipped.push({ path: candidate, reason: "too_large" });
        continue;
      }
      if (report.blocks.length >= VIBE_MAX_IMAGES_PER_MESSAGE) {
        report.skipped.push({ path: candidate, reason: "too_many" });
        continue;
      }
      try {
        var bytes = Files.readAllBytes(file.toPath());
        report.blocks.push({
          type: "image",
          mimeType: mimeType,
          data: String(Base64.getEncoder().encodeToString(bytes)),
          uri: file.toURI().toString()
        });
      } catch (readError) {
        report.skipped.push({ path: candidate, reason: String(readError) });
      }
    }
    return report;
  }

  function buildMcpServers(mcpEndpoint, options) {
    options = options || {};
    var headers = [];
    var bearerToken = managedMcpBearerToken(options);
    if (usesProtectedConvertigoMcp(mcpEndpoint, options) && bearerToken.length) {
      headers.push({
        name: "Authorization",
        value: "Bearer " + bearerToken
      });
    }
    var viewerDebugPort = intValue(options.viewerDebugPort, 0, 0, 65535);
    if (viewerDebugPort >= 1024 && normalizeSkillProfile(options) !== "nocode") {
      // The session-level server can take precedence over config.toml, so the
      // leased Studio viewer debug port must travel with it as well.
      headers.push({
        name: "X-Convertigo-Viewer-Debug-Port",
        value: String(viewerDebugPort)
      });
    }
    return [{
      type: "http",
      name: "Convertigo",
      url: vibeMcpTransportEndpoint(mcpEndpoint, options),
      headers: headers
    }];
  }

  function statusOf(entry) {
    if (entry.process !== null && entry.status !== "closed" && entry.status !== "completed" && entry.status !== "error" && entry.status !== "exited" && !processAlive(entry.process)) {
      entry.status = "exited";
      entry.closedAt = entry.closedAt || now();
    }
    return {
      handle: entry.handle,
      provider: entry.provider,
      model: entry.model || "",
      reasoningEffort: entry.reasoningEffort || "",
      serviceTier: entry.serviceTier || "",
      protocol: entry.protocol,
      codexRuntimeMode: entry.codexRuntimeMode || "",
      status: entry.status,
      phase: entry.phase,
      alive: processAlive(entry.process),
      pid: Number(entry.pid || processPid(entry.process) || 0),
      cwd: entry.cwd,
      command: entry.command,
      envKeys: entry.envKeys,
      convertigoRevealMode: entry.convertigoRevealMode === true,
      browserDebugUrl: entry.browserDebugUrl || "",
      viewerDebugPort: Number(entry.viewerDebugPort || 0),
      playwrightCdpEndpoint: entry.playwrightCdpEndpoint || entry.viewerCdpEndpoint || "",
      managedSkillBundle: entry.managedSkillBundle ? {
        ready: entry.managedSkillBundle.ready === true,
        fingerprint: entry.managedSkillBundle.fingerprint || "",
        acknowledgedFingerprint: entry.managedSkillBundle.acknowledgedFingerprint || "",
        refreshRequired: entry.managedSkillBundle.refreshRequired === true,
        pendingSlugs: entry.managedSkillBundle.pendingSlugs || [],
        missingSlugs: entry.managedSkillBundle.missingSlugs || []
      } : null,
      home: entry.home,
      credentials: {
        policy: entry.credentials.policy,
        sources: entry.credentials.sources,
        injectedKeys: entry.credentials.injectedKeys
      },
      sessionId: entry.sessionId,
      codexThreadId: entry.codexThreadId || "",
      activeTurnId: entry.activeTurnId || "",
      codexSessionFile: entry.codexSessionFile || "",
      createdAt: entry.createdAt,
      lastAccess: entry.lastAccess,
      idleMs: now() - entry.lastAccess,
      ttlMs: entry.ttlMillis,
      firstCursor: entry.firstIndex,
      nextCursor: entry.nextIndex,
      pendingCount: entry.pending.size(),
      lastError: entry.lastError,
      closedAt: entry.closedAt
    };
  }

  function startProcess(entry, env) {
    ensureAgentShutdownHook();
    var orphanSweep = sweepAllProviderPidFiles(entry.workspaceRoot || "", intValue(entry.ttlMillis, 0, 0, 86400000));
    var guard = agentGuardedCommand(entry, entry.options || {});
    entry.guarded = guard.guarded === true;
    var pb = new ProcessBuilder(toJavaList(guard.command));
    pb.directory(new File(entry.cwd));
    applyEngineProxyEnvironment(pb.environment(), agentProxyTargetUrl(entry.provider, env));
    envObjectToMap(pb.environment(), env);
    entry.process = pb.start();
    entry.writer = new BufferedWriter(new OutputStreamWriter(entry.process.getOutputStream(), StandardCharsets.UTF_8));
    writeEntryPidFile(entry);
    if (orphanSweep.stopped.length) {
      pushEvent(entry, "system/orphans_stopped", { stopped: orphanSweep.stopped });
    }
    if (!entry.guarded && guard.reason !== "disabled") {
      pushEvent(entry, "system/unguarded", {
        phase: "process/guard",
        reason: guard.reason,
        message: "This agent runs without a parent-death guard (" + guard.reason + "): it will keep running if Convertigo is killed."
      });
    }
    entry.stdoutThread = startReaderThread(entry, entry.process.getInputStream(), "stdout");
    entry.stderrThread = startReaderThread(entry, entry.process.getErrorStream(), "stderr");
    startCodexSessionWatcher(entry);
  }

  // Stops the running turn and keeps the agent process, hence the conversation context.
  // One thin adapter per protocol sends the stop message; everything else is common. A protocol
  // without adapter answers "unsupported" and the caller falls back to closing the process.
  var TURN_INTERRUPT_ADAPTERS = {
    "acp": function (entry) {
      if (!trim(entry.sessionId).length) { return false; }
      writeJson(entry, { jsonrpc: "2.0", method: "session/cancel", params: { sessionId: entry.sessionId } });
      return true;
    },
    "codex-app-server": function (entry) {
      if (!trim(entry.codexThreadId).length || !trim(entry.activeTurnId).length) { return false; }
      var id = entry.nextRequestId++;
      writeJson(entry, { jsonrpc: "2.0", id: id, method: "turn/interrupt", params: { threadId: entry.codexThreadId, turnId: entry.activeTurnId } });
      return true;
    },
    "claude-stream-json": function (entry) {
      writeJson(entry, { type: "control_request", request_id: "interrupt-" + String(UUID.randomUUID()), request: { subtype: "interrupt" } });
      return true;
    }
  };

  C8O.agentBridge.interrupt = function (options) {
    options = options || {};
    var handle = resolveHandle(options.handle);
    if (!handle.length) {
      return { ok: false, status: "error", error: "handle is required", timestamp: now() };
    }
    var entry = getRegistry().get(handle);
    if (entry === null || typeof entry === "undefined") {
      return { ok: false, status: "not_found", handle: handle, timestamp: now() };
    }
    if (!processAlive(entry.process)) {
      return { ok: false, status: "exited", handle: handle, timestamp: now() };
    }
    if (entry.turnActive !== true) {
      return { ok: true, status: "idle", handle: handle, state: statusOf(entry), timestamp: now() };
    }
    var adapter = TURN_INTERRUPT_ADAPTERS[String(entry.protocol)];
    if (typeof adapter !== "function") {
      return { ok: false, status: "unsupported", handle: handle, protocol: String(entry.protocol), timestamp: now() };
    }
    try {
      if (adapter(entry) !== true) {
        return { ok: false, status: "not_interruptible", handle: handle, timestamp: now() };
      }
    } catch (interruptError) {
      return { ok: false, status: "error", handle: handle, error: String(interruptError), timestamp: now() };
    }
    pushEvent(entry, "turn/interrupt_requested", { protocol: String(entry.protocol) });
    var deadline = now() + intValue(options.waitMs, 8000, 0, 30000);
    while (entry.turnActive === true && processAlive(entry.process) && now() < deadline) {
      try { Thread.sleep(100); } catch (_ignoreInterruptSleep) {}
    }
    var stopped = entry.turnActive !== true && processAlive(entry.process);
    return {
      ok: stopped,
      status: stopped ? "interrupted" : (processAlive(entry.process) ? "timeout" : "exited"),
      handle: handle,
      state: statusOf(entry),
      timestamp: now()
    };
  };

  C8O.agentBridge.events = function (options) {
    options = options || {};
    var handle = resolveHandle(options.handle);
    if (!handle.length) {
      return { ok: false, status: "error", error: "handle is required", timestamp: now() };
    }
    var entry = getRegistry().get(handle);
    if (entry === null || typeof entry === "undefined") {
      return { ok: false, status: "not_found", handle: handle, events: [], timestamp: now() };
    }

    var cursor = intValue(options.cursor, 0, 0, 2147483647);
    var limit = intValue(options.limit, DEFAULT_EVENT_LIMIT, 1, MAX_EVENT_LIMIT);
    var waitMs = intValue(options.waitMs, 25000, 0, 30000);
    var deadline = now() + waitMs;
    while (entry.nextIndex <= cursor && processAlive(entry.process) && now() < deadline) {
      Thread.sleep(100);
    }
    entry.lastAccess = now();

    var startCursor = cursor;
    var truncated = false;
    if (startCursor < entry.firstIndex) {
      startCursor = entry.firstIndex;
      truncated = true;
    }
    var offset = startCursor - entry.firstIndex;
    if (offset < 0) {
      offset = 0;
    }
    var events = [];
    var available = entry.events.size();
    for (var i = offset; i < available && events.length < limit; i++) {
      events.push(entry.events.get(i));
    }
    var nextCursor = events.length ? events[events.length - 1].index + 1 : startCursor;
    return {
      ok: true,
      status: "ok",
      handle: handle,
      cursor: cursor,
      nextCursor: nextCursor,
      firstCursor: entry.firstIndex,
      truncated: truncated,
      events: events,
      state: statusOf(entry),
      timestamp: now()
    };
  };

  C8O.agentBridge.status = function (options) {
    options = options || {};
    var handle = resolveHandle(options.handle);
    var registry = getRegistry();
    if (handle.length) {
      var entry = registry.get(handle);
      if (entry === null || typeof entry === "undefined") {
        return { ok: false, status: "not_found", handle: handle, timestamp: now() };
      }
      return { ok: true, status: "ok", handle: handle, state: statusOf(entry), timestamp: now() };
    }
    var handles = [];
    var iterator = registry.keySet().iterator();
    while (iterator.hasNext()) {
      var key = String(iterator.next());
      var item = registry.get(key);
      handles.push(statusOf(item));
    }
    return { ok: true, status: "ok", handles: handles, timestamp: now() };
  };

  function stopEntry(entry, removeFromRegistry) {
    try {
      if (entry.writer !== null) {
        entry.writer.close();
      }
    } catch (_ignoreWriterClose) {}
    var stoppedTree = false;
    if (entryUsesPidTree(entry) && Number(entry.pid || 0) > 0) {
      try {
        stoppedTree = destroyPidTree(Number(entry.pid));
      } catch (_ignoreDestroyTree) {}
    }
    if (!stoppedTree) {
      try {
        if (entry.process !== null && processAlive(entry.process)) {
          entry.process.destroy();
          if (!entry.process.waitFor(2000, TimeUnit.MILLISECONDS)) {
            entry.process.destroyForcibly();
          }
        }
      } catch (_ignoreDestroy) {}
    }
    deleteEntryPidFile(entry);
    entry.status = entry.status === "error" ? "error" : "closed";
    entry.closedAt = entry.closedAt || now();
    pushEvent(entry, "system/closed", {
      handle: entry.handle,
      exitCode: getExitCode(entry.process)
    });
    if (removeFromRegistry) {
      getRegistry().remove(entry.handle);
      forgetSessionHandle(entry.handle);
    }
  }

  C8O.agentBridge.sweepExpired = function (options) {
    options = options || {};
    var hardIdle = intValue(options.maxIdleSeconds, 0, 0, 86400) * 1000;
    var registry = getRegistry();
    var stopped = [];
    var kept = [];
    var iterator = registry.keySet().iterator();
    var current = now();
    while (iterator.hasNext()) {
      var handle = String(iterator.next());
      var entry = registry.get(handle);
      if (entry === null || typeof entry === "undefined") {
        continue;
      }
      var idle = current - entry.lastAccess;
      var expiredByTtl = entry.ttlMillis > 0 && idle > entry.ttlMillis;
      var expiredByHardIdle = hardIdle > 0 && idle > hardIdle;
      var dead = !processAlive(entry.process);
      if (expiredByTtl || expiredByHardIdle || dead) {
        var state = statusOf(entry);
        stopEntry(entry, true);
        stopped.push({
          handle: handle,
          reason: dead ? "dead" : "idle",
          idleMs: idle,
          state: state
        });
      } else {
        kept.push(statusOf(entry));
      }
    }
    return {
      ok: true,
      status: "ok",
      stopped: stopped,
      kept: kept,
      timestamp: current
    };
  };
