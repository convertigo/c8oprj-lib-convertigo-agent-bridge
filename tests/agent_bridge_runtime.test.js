const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const javaProxy = new Proxy(function () {}, {
  get(_target, property) {
    if (property === Symbol.toPrimitive) {
      return () => "";
    }
    if (property === "isFile" || property === "isDirectory" || property === "exists") {
      return () => false;
    }
    return javaProxy;
  },
  apply() {
    return javaProxy;
  },
  construct() {
    return javaProxy;
  }
});

global.Packages = javaProxy;
global.context = javaProxy;
global.request = javaProxy;
global.log = javaProxy;
global.C8O = { agentBridge: {} };

const commonSource = fs.readFileSync("js/agent_bridge_common.js", "utf8");
const codexSource = fs.readFileSync("js/agent_bridge_codex.js", "utf8");
const vibeSource = fs.readFileSync("js/agent_bridge_vibe.js", "utf8");
assert.doesNotMatch(commonSource + vibeSource, /ensureManagedVibeModelPresets|appendManagedVibeModelPresets/);
vm.runInThisContext(commonSource, {
  filename: "agent_bridge_common.js"
});
vm.runInThisContext(codexSource, {
  filename: "agent_bridge_codex.js"
});

const processBuilderSource = commonSource.match(/function runProcessBuilder\(pb, options\) \{[\s\S]*?\n  \}/);
assert.ok(processBuilderSource, "runProcessBuilder must remain present");
assert.ok(
  processBuilderSource[0].indexOf("pb.redirectOutput(outFile)") < processBuilderSource[0].indexOf("process.waitFor("),
  "process output must be redirected before waiting so verbose installers cannot block on full pipes"
);
const commandSource = commonSource.match(/function runCommand\(args, options\) \{[\s\S]*?\n  \}/);
assert.ok(commandSource, "runCommand must remain present");
assert.ok(
  commandSource[0].indexOf("pb.redirectOutput(outFile)") < commandSource[0].indexOf("process.waitFor("),
  "command output must be redirected before waiting"
);
const playwrightInstallSource = commonSource.match(/function ensureCodexPlaywrightRuntime\(options, installDir\) \{[\s\S]*?\n  \}/);
assert.ok(playwrightInstallSource, "ensureCodexPlaywrightRuntime must remain present");
assert.match(playwrightInstallSource[0], /options\.forceCodexPlaywrightInstall \|\| options\.forcePlaywrightInstall/);
assert.doesNotMatch(
  playwrightInstallSource[0],
  /options\.forceCodexInstall|options\.forceInstall|options\.force,/,
  "forcing a Codex CLI update must not reinstall an already usable Playwright MCP runtime"
);
assert.match(commonSource, /Agent Bridge npm installation started:/);
assert.match(commonSource, /Agent Bridge npm installation .*completed/);
assert.match(commonSource, /\["install", "--no-audit", "--no-fund", "--prefix", prefixDir, packageSpec\]/);

const compactFailure = compactCommandResult({
  command: "python -m pip install mistral-vibe",
  exitCode: 1,
  stdout: "",
  stderr: "x".repeat(5000),
  durationMs: 12,
  ok: false,
  error: ""
}, 512);

assert.equal(compactFailure.stderr.length, 516);
assert.throws(
  () => requireSuccessfulCommand(compactFailure, "Vibe runtime installation"),
  /Vibe runtime installation failed \(exit 1\)/
);
assert.equal(requireSuccessfulCommand({ ok: true }, "ignored").ok, true);
assert.equal(
  firstNonBlank([{ toString: () => "" }, "", "https://downloads.example/runtime"]),
  "https://downloads.example/runtime"
);
assert.equal(pythonDistInfoVersion("mistral_vibe-2.24.3.dist-info", "mistral-vibe"), "2.24.3");
assert.equal(pythonDistInfoVersion("other_package-2.24.3.dist-info", "mistral-vibe"), "");

const basicProxyEnv = proxyEnvironmentFromSettings({
  enabled: true,
  direct: false,
  method: "basic",
  host: "proxy.example",
  port: 3128,
  user: "domain/user",
  password: "p@ss:word",
  noProxy: "localhost,127.0.0.1"
});
assert.equal(basicProxyEnv.HTTPS_PROXY, "http://domain%2Fuser:p%40ss%3Aword@proxy.example:3128");
assert.equal(basicProxyEnv.PIP_PROXY, basicProxyEnv.HTTPS_PROXY);
assert.equal(basicProxyEnv.npm_config_https_proxy, basicProxyEnv.HTTPS_PROXY);
assert.equal(basicProxyEnv.NO_PROXY, "localhost,127.0.0.1");

const ntlmProxyEnv = proxyEnvironmentFromSettings({
  enabled: true,
  direct: false,
  method: "ntlm",
  host: "corporate-proxy.example",
  port: 8080,
  localProxyUrl: "http://127.0.0.1:19128"
});
assert.equal(ntlmProxyEnv.HTTP_PROXY, "http://127.0.0.1:19128");
assert.deepEqual(proxyEnvironmentFromSettings({ enabled: true, direct: true }), {});

assert.equal(
  redirectLocationValue({ getValue: () => "https://release-assets.example/runtime.tar.gz" }),
  "https://release-assets.example/runtime.tar.gz"
);
assert.equal(
  redirectLocationValue("Location: https://release-assets.example/runtime.tar.gz"),
  "https://release-assets.example/runtime.tar.gz"
);
assert.match(commonSource, /validateAbsoluteHttpUrl\(currentUrl\)/);
assert.match(commonSource, /source\.lastModified\(\)\) <= Number\(target\.lastModified\(\)\)/);
assert.match(commonSource, /newestUsableCodexAuthFile/);
assert.match(commonSource, /targetState\.exists && targetState\.expired/);
assert.match(commonSource, /bootstrap && bootstrap\.authenticationImported === true/);
assert.match(commonSource, /checks\["auth\.credentials"\]/);
assert.match(commonSource, /checks\["network\.provider_reachability"\]/);
assert.match(commonSource, /"account\/rateLimits\/read"/);
assert.match(commonSource, /function verifiedCodexAuthentication/);
assert.match(commonSource, /"codex-auth:" \+ hashShort/);
assert.match(commonSource, /return firstExpired !== null \? firstExpired/);
assert.match(commonSource, /"doctor", "--json"/);
assert.match(commonSource, /function detectNpxRuntimePresence/);
assert.match(commonSource, /var npx = detectNpxRuntimePresence\(options \|\| \{\}\);/);
assert.match(codexSource, /C8O\.agentBridge\.codexLoginStart/);
assert.match(codexSource, /C8O\.agentBridge\.codexLoginStatus/);
assert.match(codexSource, /authentication\.updatedAt/);
assert.match(codexSource, /entry\.process\.destroy\(\)/);
assert.match(codexSource, /appServerStartMs/);
assert.match(codexSource, /preflightMs/);
assert.equal(codexRestartThreadId({ codexThreadId: "new-thread", codexHasStartedTurn: false }), "");
assert.equal(codexRestartThreadId({ codexThreadId: "persisted-thread", codexHasStartedTurn: true }), "persisted-thread");
const readyMcpStartup = codexMcpStartupStatus({ name: "Convertigo", status: "READY" });
assert.equal(readyMcpStartup.name, "Convertigo");
assert.equal(readyMcpStartup.status, "ready");
assert.equal(readyMcpStartup.error, null);
assert.equal(readyMcpStartup.failureReason, null);
assert.match(codexSource, /waitForCodexMcpReady\([\s\S]*managedMcpServerName/);
assert.match(codexSource, /startupPresenceOnly: true/);
assert.match(codexSource, /var startupPresenceOnly = boolValue\(options\.startupPresenceOnly, false\)/);
assert.match(codexSource, /revealModeChanged \? "reveal_mode_changed"/);
assert.match(codexSource, /if \(skillBundleChanged\) \{[\s\S]*bootstrapCodexHome/);
assert.doesNotMatch(
  codexSource.slice(codexSource.indexOf("C8O.agentBridge.codexPrompt = function"), codexSource.indexOf("var latestSkillBundle")),
  /bootstrapCodexHome/,
  "an unchanged active conversation must not bootstrap CODEX_HOME again before each prompt"
);
const originalDetectCodexRuntimePresence = detectCodexRuntimePresence;
const originalBootstrapCodexHome = bootstrapCodexHome;
const originalInstallAgentSkills = installAgentSkills;
const originalCodexDoctorAuthentication = codexDoctorAuthentication;
const originalFlowCapabilityAvailable = flowCapabilityAvailable;
const originalCommandPathStartsWith = commandPathStartsWith;
const originalDetectCodexRuntime = detectCodexRuntime;
let presenceChecks = 0;
detectCodexRuntimePresence = () => {
  presenceChecks += 1;
  return {
    workspaceRoot: "/tmp/workspace",
    installDir: "/tmp/workspace/agents/codex",
    codexHome: "/tmp/workspace/agents/codex/home",
    home: { path: "/tmp/workspace/agents/codex/home", error: "" },
    mcpEndpoint: "http://localhost:18082/convertigo/api/mcp",
    codex: { found: true, path: "/tmp/workspace/agents/codex/bin/codex" },
    playwright: { installed: true },
    mcp: { ok: true, hasLegacy: true, hasFlow: false, hasManagedServer: true, managedServerName: "convertigo" }
  };
};
bootstrapCodexHome = () => ({ attempted: true, ok: true, authenticationImported: false, generated: [], reused: ["config.toml"] });
installAgentSkills = () => ({ ok: true, message: "skills current", bundle: { fingerprint: "current" } });
let startupDoctorForceCheck = null;
codexDoctorAuthentication = (_options, _home, _command, forceCheck) => {
  startupDoctorForceCheck = forceCheck;
  return { configured: true, status: "configured" };
};
flowCapabilityAvailable = () => false;
commandPathStartsWith = () => true;
detectCodexRuntime = () => { throw new Error("startup must not execute CLI runtime probes"); };
const presenceSetupResult = C8O.agentBridge.codexSetup({ startupPresenceOnly: true });
assert.equal(presenceSetupResult.ok, true);
assert.equal(presenceSetupResult.startupPresenceOnly, true);
assert.equal(presenceSetupResult.setup.playwright.found, true);
assert.equal(presenceChecks, 2);
assert.equal(startupDoctorForceCheck, false);
assert.equal(presenceSetupResult.timings.totalMs >= 0, true);
assert.match(codexSource, /setupDetails: setup\.timings \|\| \{\}/);
assert.match(vibeSource, /startupPresenceOnly: true/);
assert.match(vibeSource, /buildMcpServers\(mcpEndpoint, options\)/);
assert.match(vibeSource, /status: ready \? "ready" : \(!skillsReady \? "configuration_error"/);
assert.match(commonSource, /callLocalSequence\(setupProject, "_setupVibe"/);
assert.match(commonSource, /skills\/convertigo-vibe-generalist\/SKILL\.md/);
assert.match(commonSource, /invalidatePersistentProviderSettingsCache/);
assert.match(commonSource, /vibeConfigRequiresAuthMigration/);
assert.equal(vibeConfigRequiresAuthMigration([
  "[[mcp_servers]]",
  'name = "Convertigo"',
  "",
  "[mcp_servers.headers]",
  'X-Test = "value"',
  "",
  "[mcp_servers.auth]",
  'type = "static"'
].join("\n")), true);
assert.equal(vibeConfigRequiresAuthMigration([
  "[[mcp_servers]]",
  'name = "Convertigo"',
  "",
  "[mcp_servers.auth]",
  'type = "static"',
  'headers = { X-Test = "value" }'
].join("\n")), false);
assert.equal(vibeConfigRequiresAuthMigration([
  "[[mcp_servers]]",
  'name = "Other"',
  "[mcp_servers.headers]",
  'X-Test = "value"',
  "",
  "[[mcp_servers]]",
  'name = "Convertigo"',
  "[mcp_servers.auth]",
  'type = "static"'
].join("\n")), false);
const setupVibeResult = findSetupVibeResult({
  document: {
    setupVibeResult: {
      skillStatus: "created",
      resolvedVibeHome: "/tmp/vibe-home",
      skillPath: "/tmp/vibe-home/skills/convertigo-vibe-generalist/SKILL.md"
    }
  }
}, 0);
assert.equal(setupVibeResult.skillStatus, "created");
assert.match(agentSkillInstructions("vibe", "generalist"), /skills\/convertigo-vibe-generalist\/SKILL\.md/);
assert.doesNotMatch(agentSkillInstructions("vibe", "generalist"), /skills\/convertigo-mcp\/AGENT\.md/);
assert.match(agentSkillInstructions("vibe", "generalist"), /exactly one Convertigo MCP tool call per assistant message/);
assert.match(agentSkillInstructions("vibe", "generalist"), /Do not wait with shell `sleep`/);
detectCodexRuntimePresence = originalDetectCodexRuntimePresence;
bootstrapCodexHome = originalBootstrapCodexHome;
installAgentSkills = originalInstallAgentSkills;
codexDoctorAuthentication = originalCodexDoctorAuthentication;
flowCapabilityAvailable = originalFlowCapabilityAvailable;
commandPathStartsWith = originalCommandPathStartsWith;
detectCodexRuntime = originalDetectCodexRuntime;

const originalEngineProductVersion = engineProductVersion;
const originalProjectDirectoryByName = projectDirectoryByName;
let flowProjectLookups = 0;
engineProductVersion = () => "8.4.9";
projectDirectoryByName = () => {
  flowProjectLookups += 1;
  return null;
};
assert.equal(flowCapabilityAvailability().available, false);
assert.equal(flowProjectLookups, 0, "unsupported Studio versions must not inspect Flow projects");
assert.match(commonSource, /getAllProjectNamesList\(false\)/);
engineProductVersion = originalEngineProductVersion;
projectDirectoryByName = originalProjectDirectoryByName;
assert.match(commonSource, /Bootstrap is required once per agent conversation/);
assert.match(commonSource, /already used successfully in the current conversation/);
assert.match(commonSource, /Common NGX contracts that do not require palette discovery/);
assert.match(commonSource, /Never recursively search a drive root, user profile, workspace root/);
assert.match(commonSource, /stateOnly:true, wait:true, timeoutSec:180/);
assert.match(commonSource, /preserve the complete existing string and every `Begin_c8o_/);
assert.match(commonSource, /must match `\[A-Za-z_\$\]\[A-Za-z0-9_\$\]\*`/);
assert.match(commonSource, /optimizeMutations:true/);
assert.match(commonSource, /Do not inspect `ALL_TOOLS`/);
assert.equal(resolvePlaywrightMcpCdpEndpoint({ viewerDebugPort: 40811 }), "http://127.0.0.1:40811");

const revealModePrompt = withRevealModePrompt("Build a Flow frontend", true);
assert.doesNotMatch(withRevealModePrompt("Build an application", true), /\bFlow\b|convertigo-flow/i);
assert.match(commonSource, /Convertigo project descriptors are MCP-owned/);

const revealPrompt = withRevealModePrompt("User message", true);
assert.match(revealPrompt, /batch-call`, pass top-level `reveal:true`/);
assert.equal(
  withRevealModePrompt(revealPrompt, true).split("Convertigo runtime reveal mode is enabled").length,
  2,
  "reveal guidance must be idempotent"
);

const managedPreflightPrompt = withManagedGuidancePreflight("User message", {
  mcpEndpoint: "http://localhost:18082/convertigo/api/mcp"
});
assert.match(managedPreflightPrompt, /Scoped agent setup status: current/);
assert.match(managedPreflightPrompt, /2026-09-04\.vibe-serial-transport-v1/);
assert.match(managedPreflightPrompt, /Do not call `_setupCodex`/);
const refreshedBundlePrompt = withManagedGuidancePreflight("User message", {
  skillBundle: {
    fingerprint: "bundle-20260901",
    refreshRequired: true,
    pendingSlugs: ["convertigo-studio", "convertigo-flow-frontend-svelte"]
  }
});
assert.match(refreshedBundlePrompt, /managed skill bundle fingerprint: bundle-20260901/);
assert.match(refreshedBundlePrompt, /fully reread these updated skills: convertigo-studio, convertigo-flow-frontend-svelte/);
assert.match(refreshedBundlePrompt, /bridge records the actual reads/);
assert.equal(
  withManagedGuidancePreflight(managedPreflightPrompt, {}).split("Convertigo managed preflight for this turn").length,
  2,
  "managed guidance preflight must be idempotent"
);
assert.match(commonSource, /MANAGED_SKILL_BUNDLE_STATE_FILE = "managed-skill-bundle\.json"/);
assert.match(commonSource, /function managedSkillBundleState/);
assert.match(codexSource, /function recordCodexManagedSkillReads/);
assert.doesNotMatch(
  codexSource,
  /!entry\.sessionId\.length[\s\S]{0,300}acknowledgeManagedSkillBundle/,
  "fresh bundle baselining must remain explicit instead of piggybacking on a missing session id"
);
assert.match(codexSource, /reason: "skill_bundle_changed"/);
assert.deepEqual(
  codexManagedSkillReadSlugs("/bin/zsh -lc sed -n '1,240p' /tmp/codex-home/skills/convertigo-flow-frontend-svelte/SKILL.md"),
  ["convertigo-flow-frontend-svelte"]
);
assert.deepEqual(
  codexManagedSkillReadSlugs("cat C:\\codex-home\\skills\\convertigo-studio\\SKILL.md"),
  ["convertigo-studio"]
);
const originalAcknowledgeManagedSkillBundle = acknowledgeManagedSkillBundle;
const originalPushEvent = pushEvent;
let acknowledgedSkillBundle = null;
acknowledgeManagedSkillBundle = (_homePath, bundle) => {
  acknowledgedSkillBundle = bundle.fingerprint;
  return true;
};
pushEvent = () => {};
const splitSkillReadEntry = {
  home: { path: "/tmp/codex-home" },
  managedSkillBundle: {
    ready: true,
    fingerprint: "bundle-split-events",
    acknowledgedFingerprint: "old-bundle",
    refreshRequired: true,
    pendingSlugs: ["convertigo-flow-frontend-svelte"],
    skills: { "convertigo-flow-frontend-svelte": "hash" }
  },
  managedSkillBundleReadSlugs: {},
  managedSkillBundleReadCalls: {}
};
assert.equal(handleCodexManagedSkillReadItem(splitSkillReadEntry, {
  id: "skill-read-1",
  type: "command_execution",
  command: "sed -n '1,240p' /tmp/codex-home/skills/convertigo-flow-frontend-svelte/SKILL.md"
}, false), true);
assert.equal(handleCodexManagedSkillReadItem(splitSkillReadEntry, {
  id: "skill-read-1",
  type: "command_execution",
  output: "skill content without its source path"
}, true), true);
assert.equal(acknowledgedSkillBundle, "bundle-split-events");
assert.equal(splitSkillReadEntry.managedSkillBundle.refreshRequired, false);

const freshSkillEntry = {
  home: { path: "/tmp/codex-home" },
  codexHasStartedTurn: false,
  managedSkillBundle: {
    ready: true,
    fingerprint: "fresh-bundle",
    acknowledgedFingerprint: "",
    refreshRequired: true,
    pendingSlugs: ["convertigo-studio", "convertigo-generalist"],
    skills: { "convertigo-studio": "one", "convertigo-generalist": "two" }
  }
};
assert.equal(baselineFreshCodexSkillBundle(freshSkillEntry), true);
assert.equal(freshSkillEntry.managedSkillBundle.refreshRequired, false);
assert.deepEqual(freshSkillEntry.managedSkillBundle.pendingSlugs, []);
freshSkillEntry.codexHasStartedTurn = true;
freshSkillEntry.managedSkillBundle.acknowledgedFingerprint = "";
assert.equal(baselineFreshCodexSkillBundle(freshSkillEntry), false,
  "a resumed conversation must still reread changed managed skills");
acknowledgeManagedSkillBundle = originalAcknowledgeManagedSkillBundle;
pushEvent = originalPushEvent;
assert.match(codexSource, /C8O\.agentBridge\.sweepExpired\(\{\}\)/);
assert.match(commonSource, /destroyPidTree\(Number\(entry\.pid\)\)/);

assert.equal(
  managedMcpTransportEndpoint("http://localhost:18082/convertigo/api/mcp"),
  "http://localhost:18082/convertigo/api/mcp?jsonOnly=true"
);
assert.equal(
  managedMcpTransportEndpoint("http://localhost:18082/convertigo/api/mcp?transport=managed&jsonOnly=false#viewer"),
  "http://localhost:18082/convertigo/api/mcp?transport=managed&jsonOnly=true#viewer"
);
assert.equal(
  vibeMcpTransportEndpoint("http://localhost:18082/convertigo/api/mcp?transport=managed&jsonOnly=true#viewer"),
  "http://localhost:18082/convertigo/api/mcp?transport=managed&jsonOnly=false&descriptorVersion=2026-09-04.vibe-serial-transport-v1#viewer"
);
// Vibe caches the MCP tool catalog for 24 h under sha256 of the serialized
// server entry, so the deployed catalog identity has to travel in the URL or a
// stack upgrade stays invisible to an existing home.
const originalManagedMcpCatalogRevision = managedMcpCatalogRevision;
managedMcpCatalogRevision = () => "a1b2c3";
assert.equal(
  vibeMcpTransportEndpoint("http://localhost:18082/convertigo/api/mcp"),
  "http://localhost:18082/convertigo/api/mcp?jsonOnly=false&descriptorVersion=2026-09-04.vibe-serial-transport-v1&toolsRevision=a1b2c3"
);
assert.equal(
  vibeMcpTransportEndpoint("http://localhost:18082/convertigo/api/mcp?transport=managed#viewer"),
  "http://localhost:18082/convertigo/api/mcp?transport=managed&jsonOnly=false&descriptorVersion=2026-09-04.vibe-serial-transport-v1&toolsRevision=a1b2c3#viewer",
  "the cache-busting parameter must stay inside the query, before the fragment"
);
const firstRevisionEndpoint = vibeMcpTransportEndpoint("http://localhost:18082/convertigo/api/mcp");
managedMcpCatalogRevision = () => "d4e5f6";
const secondRevisionEndpoint = vibeMcpTransportEndpoint("http://localhost:18082/convertigo/api/mcp");
assert.notEqual(
  firstRevisionEndpoint,
  secondRevisionEndpoint,
  "two MCP catalog revisions must produce two URLs, otherwise Vibe reuses its cached tool list"
);
assert.match(
  secondRevisionEndpoint,
  /[?&]descriptorVersion=2026-09-04\.vibe-serial-transport-v1(&|$)/,
  "descriptorVersion is compared byte for byte by the MCP guidance check and must stay untouched"
);
assert.equal(
  buildMcpServers("http://localhost:18082/convertigo/api/mcp")[0].url,
  secondRevisionEndpoint,
  "the session-level server must carry the same URL as config.toml, or Vibe keeps two catalog caches"
);
managedMcpCatalogRevision = originalManagedMcpCatalogRevision;
assert.match(
  vibeSource,
  /writeLocalVibeConfig\([\s\S]{0,400}?pruneVibeDescriptorCache\(setup\.vibeHome\)/,
  "rewriting the MCP server entry must drop the descriptor cache discovered under the previous one"
);
const compactCodexConfig = patchCodexMcpConfigText(
  "",
  "http://localhost:18082/convertigo/api/mcp",
  {},
  "/tmp/codex-home"
);
assert.match(compactCodexConfig.text, /url = "http:\/\/localhost:18082\/convertigo\/api\/mcp\?jsonOnly=true"/);
const sessionCodexConfig = patchCodexMcpConfigText(
  compactCodexConfig.text,
  "http://localhost:18082/convertigo/api/mcp",
  { mcpSessionCookie: "JSESSIONID=session-one" },
  "/tmp/codex-home"
);
assert.match(sessionCodexConfig.text, /"Cookie" = "JSESSIONID=session-one"/);
assert.equal(mcpSessionCookieFromConfig(sessionCodexConfig.text, "convertigo"), "JSESSIONID=session-one");
const refreshedSessionCodexConfig = patchCodexMcpConfigText(
  sessionCodexConfig.text,
  "http://localhost:18082/convertigo/api/mcp",
  { mcpSessionCookie: "JSESSIONID=session-two" },
  "/tmp/codex-home"
);
assert.match(refreshedSessionCodexConfig.text, /"Cookie" = "JSESSIONID=session-two"/);
assert.doesNotMatch(refreshedSessionCodexConfig.text, /JSESSIONID=session-one/);
const mixedHeaderCodexConfig = patchCodexMcpConfigText(
  [
    "[mcp_servers.convertigo]",
    'url = "http://localhost:18082/convertigo/api/mcp?jsonOnly=true"',
    'http_headers = { "X-Convertigo-Guidance-Version" = "old", "Cookie" = "JSESSIONID=inline-session" }',
    "",
    "[mcp_servers.convertigo.http_headers]",
    '"X-Convertigo-Viewer-Debug-Port" = "40457"',
    '"Cookie" = "JSESSIONID=nested-session"',
    ""
  ].join("\n"),
  "http://localhost:18082/convertigo/api/mcp",
  { viewerDebugPort: 40457, mcpSessionCookie: "JSESSIONID=refreshed-session" },
  "/tmp/codex-home"
);
assert.doesNotMatch(mixedHeaderCodexConfig.text, /\[mcp_servers\.convertigo\.http_headers\]/);
assert.equal((mixedHeaderCodexConfig.text.match(/^http_headers\s*=/gm) || []).length, 1);
assert.match(mixedHeaderCodexConfig.text, /"X-Convertigo-Viewer-Debug-Port" = "40457"/);
assert.match(mixedHeaderCodexConfig.text, /"Cookie" = "JSESSIONID=refreshed-session"/);
assert.equal((mixedHeaderCodexConfig.text.match(/The Studio JxBrowser CDP endpoint is written here/g) || []).length, 1);
assert.equal(mcpSessionCookieFromConfig(
  '[mcp_servers.convertigo.http_headers]\nCookie = "JSESSIONID=nested-session"\n',
  "convertigo"
), "JSESSIONID=nested-session");
const revealCodexConfig = patchCodexMcpConfigText(
  compactCodexConfig.text,
  "http://localhost:18082/convertigo/api/mcp",
  { agentRevealMode: "true" },
  "/tmp/codex-home"
);
assert.match(revealCodexConfig.text, /"X-Convertigo-Reveal-Mode" = "true"/);
assert.doesNotMatch(
  patchCodexMcpConfigText(revealCodexConfig.text, "http://localhost:18082/convertigo/api/mcp", {}, "/tmp/codex-home").text,
  /X-Convertigo-Reveal-Mode/
);
assert.equal(agentCapabilityProfile({ agentProfile: "flow", userId: "studio" }).id, "generalist");
flowCapabilityAvailability = () => ({ available: true });
const flowRevealModePrompt = withRevealModePrompt("Build a Flow frontend", true);
assert.match(flowRevealModePrompt, /pass `reveal:true` to `code-set` or `code-patch`/);
assert.match(flowRevealModePrompt, /`actionId:"dev\.open"`/);
assert.match(flowRevealModePrompt, /`browserControlReady:true`/);
const flowProfile = agentCapabilityProfile({ agentProfile: "flow", userId: "studio" });
assert.equal(flowProfile.id, "flow");
assert.equal(flowProfile.mcpServerName, "convertigo-flow");
assert.deepEqual(flowProfile.supportedProviders, ["codex"]);
const flowCodexConfig = patchCodexMcpConfigText(
  compactCodexConfig.text,
  "http://localhost:18082/convertigo/api/flow-mcp",
  { agentProfile: "flow", userId: "studio" },
  "/tmp/codex-home"
);
assert.match(flowCodexConfig.text, /\[mcp_servers\.convertigo-flow\]/);
assert.match(flowCodexConfig.text, /url = "http:\/\/localhost:18082\/convertigo\/api\/flow-mcp\?jsonOnly=true"/);
assert.match(flowCodexConfig.text, /bearer_token_env_var = "CONVERTIGO_MCP_TOKEN"/);
assert.match(flowCodexConfig.text, /\[mcp_servers\.convertigo\]/);
assert.equal(
  managedMcpBearerToken({ agentProfile: "flow", mcpBearerToken: "shared-jwt" }),
  "shared-jwt"
);
assert.equal(
  managedMcpBearerToken({ agentProfile: "flow", mcpBearerToken: JSON.stringify({ legacy: "legacy-jwt", flow: "flow-jwt" }) }),
  "legacy-jwt"
);
const managedTokenEnvironment = applyManagedMcpEnvironment({}, {
  agentProfile: "flow",
  mcpBearerToken: "shared-jwt"
});
assert.equal(managedTokenEnvironment.CONVERTIGO_MCP_TOKEN, "shared-jwt");
assert.equal(
  buildMcpServers("http://localhost:18082/convertigo/api/mcp")[0].url,
  "http://localhost:18082/convertigo/api/mcp?jsonOnly=false&descriptorVersion=2026-09-04.vibe-serial-transport-v1"
);
assert.deepEqual(
  buildMcpServers("http://localhost:18082/convertigo/api/mcp", { mcpBearerToken: "managed-jwt" })[0].headers,
  [{ name: "Authorization", value: "Bearer managed-jwt" }]
);
assert.deepEqual(buildMcpServers("http://localhost:18082/convertigo/api/mcp")[0].headers, []);
assert.deepEqual(
  buildMcpServers("https://example.test/unrelated-mcp", { mcpBearerToken: "managed-jwt" })[0].headers,
  [],
  "the managed Convertigo token must not be forwarded to unrelated endpoints"
);

const pythonSpec = pythonRuntimeSpec({
  pythonVersion: "3.12.13",
  pythonBuildTag: "20260610",
  pythonPlatform: "aarch64-apple-darwin",
  pythonArchiveFlavor: "install_only_stripped",
  pythonInstallDir: "/tmp/convertigo-python"
}, "/tmp/convertigo-workspace");

assert.equal(
  pythonSpec.archiveUrl,
  "https://github.com/astral-sh/python-build-standalone/releases/download/20260610/cpython-3.12.13%2B20260610-aarch64-apple-darwin-install_only_stripped.tar.gz"
);

const vibeProvider = normalizeVibeAcpProviderSettings([
  {
    id: "model",
    currentValue: "zai-glm-5-2",
    options: [
      { value: "vibe-thinking", name: "Vibe Thinking", description: "mistral-vibe-cli-latest" },
      { value: "zai-glm-5-2", name: "Z.ai GLM 5.2", description: "zai-glm-5-2" }
    ]
  },
  {
    id: "thinking",
    currentValue: "high",
    options: ["off", "low", "medium", "high", "max"].map((value) => ({ value, name: value }))
  }
], {
  id: "vibe",
  source: {},
  supports: {}
});

assert.equal(vibeProvider.defaultModel, "zai-glm-5-2");
assert.equal(vibeProvider.models.length, 2);
assert.equal(vibeProvider.models[1].label, "Z.ai GLM 5.2");
assert.equal(vibeProvider.models[1].configuredName, "zai-glm-5-2");
assert.deepEqual(vibeProvider.models[1].reasoningLevels.map((level) => level.id), ["off", "low", "medium", "high", "max"]);
assert.equal(vibeProvider.models[1].defaultReasoning, "high");
assert.equal(vibeProvider.reasoningMode, "runtime_selectable");
assert.equal(vibeProvider.supports.reasoning, true);

const vibeConfigWithPreset = [
  'active_model = "vibe-thinking"',
  "",
  "[[models]]",
  'name = "mistral-vibe-cli-latest"',
  'provider = "mistral"',
  'alias = "vibe-thinking"',
  "",
  "[[mcp_servers]]",
  'name = "Convertigo"'
].join("\n");
const unchangedVibeConfig = migrateManagedVibeModelPresets(vibeConfigWithPreset);
assert.deepEqual(unchangedVibeConfig.removed, []);
assert.equal(unchangedVibeConfig.added, true);
assert.match(unchangedVibeConfig.text, /alias = "glm-5-2"/);
assert.equal(migrateManagedVibeModelPresets(unchangedVibeConfig.text).text, unchangedVibeConfig.text);

const migratedVibeConfig = migrateManagedVibeModelPresets([
  'active_model = "zai-glm-5-2"',
  "",
  "[[models]]",
  'name = "zai-glm-5-2"',
  'provider = "mistral"',
  'alias = "zai-glm-5-2"',
  "input_price = 1.4",
  "output_price = 4.4",
  'thinking = "high"',
  "",
  "[[mcp_servers]]",
  'name = "Convertigo"'
].join("\n"));
assert.deepEqual(migratedVibeConfig.removed, ["zai-glm-5-2"]);
assert.equal(migratedVibeConfig.migratedActiveModel, true);
assert.match(migratedVibeConfig.text, /active_model = "glm-5-2"/);
assert.doesNotMatch(migratedVibeConfig.text, /alias = "zai-glm-5-2"/);
assert.match(migratedVibeConfig.text, /\[\[mcp_servers\]\]/);
assert.equal(vibeModelSpec("zai-glm-5-2").activeModel, "glm-5-2");
assert.equal(vibeModelSpec("glm-5-2").builtIn, false);
assert.match(migratedVibeConfig.text, /name = "zai-glm-5-2"/);
const customGlm = '[[models]]\nname = "zai-glm-5-2"\nprovider = "custom"\nalias = "my-glm"\n';
assert.equal(migrateManagedVibeModelPresets(customGlm).text, customGlm);

const uncachedProvider = requireCachedProviderConfiguration({
  id: "codex",
  status: "ready",
  ready: true,
  defaultModel: "",
  models: []
});
assert.equal(uncachedProvider.ready, false);
assert.equal(uncachedProvider.status, "configuration_required");

const staleProvider = requireCachedProviderConfiguration({
  id: "codex",
  status: "ready",
  ready: true,
  defaultModel: "gpt-current",
  models: [{ id: "gpt-old" }]
});
assert.equal(staleProvider.ready, false);
assert.equal(staleProvider.status, "configuration_required");

const configuredProvider = requireCachedProviderConfiguration({
  id: "codex",
  status: "ready",
  ready: true,
  defaultModel: "gpt-current",
  models: [{ id: "gpt-current" }]
});
assert.equal(configuredProvider.ready, true);
assert.equal(configuredProvider.status, "ready");

const persistedPreferences = validatedAgentPreferences({
  confirmed: true,
  provider: "codex",
  model: "gpt-current",
  reasoning: "high",
  serviceTier: "priority",
  updatedAt: 123
}, [{
  id: "codex",
  ready: true,
  defaultModel: "gpt-current",
  models: [{
    id: "gpt-current",
    defaultReasoning: "medium",
    reasoningLevels: [{ id: "low" }, { id: "medium" }, { id: "high" }]
  }],
  supports: { reasoning: true }
}]);
assert.deepEqual(persistedPreferences, {
  confirmed: true,
  provider: "codex",
  model: "gpt-current",
  reasoning: "high",
  serviceTier: "priority",
  updatedAt: 123
});
assert.equal(validatedAgentPreferences({ provider: "missing" }, [{ id: "codex", ready: true }]), null);

const unauthenticatedProvider = requireProviderAuthentication({
  id: "codex",
  status: "ready",
  ready: true,
  runtime: { installed: true },
  authentication: authenticationInfo(false, "", "codex_login"),
  source: {}
});
assert.equal(unauthenticatedProvider.ready, false);
assert.equal(unauthenticatedProvider.status, "authentication_required");
assert.equal(unauthenticatedProvider.authentication.action, "codex_login");

const authenticatedProvider = requireProviderAuthentication({
  id: "vibe",
  status: "ready",
  ready: true,
  runtime: { installed: true },
  authentication: authenticationInfo(true, "scoped_home", ""),
  source: {}
});
assert.equal(authenticatedProvider.ready, true);
assert.equal(authenticatedProvider.status, "ready");

console.log("Agent Bridge runtime contract OK");
