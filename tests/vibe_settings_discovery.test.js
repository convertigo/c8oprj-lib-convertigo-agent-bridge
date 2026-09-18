const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('js/agent_bridge_vibe.js', 'utf8');
const discovery = source.match(/C8O\.agentBridge\.discoverVibeSettings = function \(options, provider\) \{[\s\S]*?\n  \};/)[0];
let captured;
let closed = 0;
let result;
const bridge = {
  vibeStart(options) { captured = options; return result; },
  vibeClose() { closed++; }
};
vm.runInNewContext(discovery, {
  C8O: { agentBridge: bridge },
  makeHandle: () => 'settings-test',
  trim: value => String(value || '').trim(),
  resolveVibeProfile: () => 'mistral',
  applyGatewayOfferToProvider: provider => provider
});
const options = { mcpBearerTokenHandle: 'opaque-handle', nocodeMcpTokenHandle: 'nocode-handle' };
result = { ok: true, providerSettings: { models: [{ id: 'glm-5-2' }] } };
assert.equal(bridge.discoverVibeSettings(options, {}), result.providerSettings);
assert.equal(captured.mcpBearerTokenHandle, options.mcpBearerTokenHandle);
assert.equal(captured.nocodeMcpTokenHandle, options.nocodeMcpTokenHandle);
assert.equal(captured.install, false);
assert.equal(closed, 1);
result = { ok: false, error: 'Discovery failed' };
const fallback = { models: [{ id: 'existing' }], source: {} };
assert.equal(bridge.discoverVibeSettings({}, fallback), fallback);
assert.equal(fallback.source.discoveryError, 'Discovery failed');
assert.equal(fallback.source.settingsCachedAt, 0);
assert.equal(closed, 2);

const common = fs.readFileSync('js/agent_bridge_common.js', 'utf8');
const settings = common.match(/function vibeSettings\(options\) \{[\s\S]*?\n  \}/)[0];
assert.match(settings, /detectRuntimePresence\(options\)/);
assert.doesNotMatch(settings, /detectRuntime\(options\)/);
assert.match(common, /var text = migrateManagedVibeModelPresets\(lines\.join\("\\n"\)\)\.text/);
console.log('Vibe settings discovery tests passed');
const cacheSandbox = {
  readPersistentProviderSettingsCache: () => ({ models: [{ id: 'old' }], cachedAt: 1000, defaults: {} }),
  providerCacheKey: () => 'vibe:test',
  applyGatewayOfferToProvider: provider => provider,
  enforceThinkingReasoningLevels: provider => provider,
  trim: value => String(value || '').trim(),
  now: () => 1500
};
for (const name of ['hydrateProviderSettingsFromCache', 'providerSettingsCacheFresh']) {
  const method = common.match(new RegExp('function ' + name + '\\([^]*?\\n  \\}'))[0];
  vm.runInNewContext(method, cacheSandbox);
}
const changed = { id: 'vibe', source: { modelCatalogRefreshRequired: true } };
cacheSandbox.hydrateProviderSettingsFromCache('', changed, true);
cacheSandbox.hydrateProviderSettingsFromCache('', changed, true);
assert.equal(changed.source.settingsCachedAt, 0);
assert.equal(cacheSandbox.providerSettingsCacheFresh(changed, 60000), false);
const unchanged = { id: 'vibe', source: {} };
cacheSandbox.hydrateProviderSettingsFromCache('', unchanged, true);
assert.equal(cacheSandbox.providerSettingsCacheFresh(unchanged, 60000), true);
console.log('Vibe repeated cache hydration invalidation tests passed');

// Playwright MCP is launched through node + cli.js (no npx .cmd shim) and a stale command rewrites the config.
{
  const toml = '[[mcp_servers]]\nname = "Convertigo"\ntransport = "http"\nurl = "http://localhost:18080/convertigo/api/mcp?jsonOnly=true"\n\n[[mcp_servers]]\nname = "playwright"\ntransport = "stdio"\ncommand = "D:\\\\Studio 8\\\\nodes\\\\npx.cmd"\nargs = [\n    "--cdp-endpoint",\n    "http://127.0.0.1:40250",\n]\n';
  const regex = /\ncommand\s*=\s*\[\s*"((?:[^"\\]|\\.)*)"/;
  const playwrightBlock = toml.match(/\[\[mcp_servers\]\]([\s\S]*?)(?=\n\[\[mcp_servers\]\]|$)/g).find((block) => /name\s*=\s*["']playwright["']/.test(block));
  assert.equal(playwrightBlock.match(regex), null, "a legacy string command must not be recognised so the config is rewritten");
  const listForm = playwrightBlock.replace(/\ncommand = "([^\n]*)"/, '\ncommand = [\n    "$1",\n]');
  assert.equal(listForm.match(regex)[1].replace(/\\(.)/g, "$1"), "D:\\Studio 8\\nodes\\npx.cmd", "the list form must be parsed and unescaped");
  const commonText2 = fs.readFileSync("js/agent_bridge_common.js", "utf8");
  assert.match(commonText2, /'command = ' \+ tomlArray\(\[playwright\.command\]\)/, "Vibe stdio command must be written as a TOML list (Vibe shlex-splits strings)");
  const commonText = fs.readFileSync("js/agent_bridge_common.js", "utf8");
  assert.match(commonText, /function playwrightMcpDirectLaunch\(options, installDir\)/);
  assert.match(commonText, /"@playwright\/mcp"\), "cli\.js"\)/);
  assert.match(fs.readFileSync("js/agent_bridge_vibe.js", "utf8"), /trim\(setup\.config\.selected\.playwrightCommand\) === expectedPlaywrightCommand/);
  assert.match(fs.readFileSync("js/agent_bridge_claude.js", "utf8"), /var direct = playwrightMcpDirectLaunch\(options, installDir\);/);
}
