// browser_run_code_unsafe of the managed Playwright MCP runs any script in the Playwright MCP process: a Mistral Large 4
// turn through Vibe called it again and again instead of the dedicated tools. No managed runtime offers it any more: the
// provider runtime denies it with --disallowedTools, Codex and Vibe list it in the disabled_tools of the `playwright`
// server of their config.toml. No instruction text recommends it: proofs go to browser-verify (low-code) or to the
// dedicated Playwright tools (Flow, a session without browser-verify); browser_evaluate stays.
// node --test tests/playwright_tool_exclusion.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const javaProxy = new Proxy(function(){},{get(_t,p){if(p===Symbol.toPrimitive)return ()=>'';if(p==='isFile'||p==='isDirectory'||p==='exists')return ()=>false;return javaProxy;},apply(){return javaProxy;},construct(){return javaProxy;}});
global.Packages=javaProxy;global.context=javaProxy;global.request=javaProxy;global.log=javaProxy;global.C8O={agentBridge:{}};
for(const name of ['common','codex','vibe','claude'])vm.runInThisContext(fs.readFileSync(path.join(root,'js/agent_bridge_'+name+'.js'),'utf8'),{filename:'agent_bridge_'+name+'.js'});
const source = (name) => fs.readFileSync(path.join(root, 'js/agent_bridge_' + name + '.js'), 'utf8');

const EXCLUDED = 'disabled_tools = ["browser_run_code_unsafe"]';

function withGlobals(fakes, run) {
  const saved = {};
  for (const [name, value] of Object.entries(fakes)) { saved[name] = global[name]; global[name] = value; }
  try { return run(); } finally { for (const [name, value] of Object.entries(saved)) global[name] = value; }
}

// the lines of the TOML table or array element that starts at `header`, up to the next table header
function tomlBlock(text, header) {
  const lines = text.split('\n');
  const start = lines.findIndex((line, index) => line === header && (header !== '[[mcp_servers]]' || lines[index + 1] === 'name = "playwright"'));
  assert.ok(start >= 0, header + ' in\n' + text);
  const end = lines.findIndex((line, index) => index > start && /^\[/.test(line));
  return lines.slice(start + 1, end < 0 ? lines.length : end);
}

test('the excluded tools are the unsafe script tool only', () => {
  assert.deepEqual(Array.from(PLAYWRIGHT_MCP_EXCLUDED_TOOLS), ['browser_run_code_unsafe']);
});

test('Codex: the playwright server of config.toml leaves the tool out, enabled or not', () => {
  withGlobals({
    resolvePlaywrightMcpCdpEndpoint: () => 'http://127.0.0.1:45678',
    codexPlaywrightMcpCommand: () => '/agents/codex/npm/bin/npx',
    playwrightViewerInitArgs: () => []
  }, () => {
    for (const playwrightMcpEnabled of ['true', 'false']) {
      const patched = patchCodexPlaywrightMcpConfigText('model = "gpt-5"\n', { viewerDebugPort: 45678, codexHomeScope: 'conversation', playwrightMcpEnabled }, '/agents/codex');
      const block = tomlBlock(patched.text, '[mcp_servers.playwright]');
      assert.ok(block.includes(EXCLUDED), block.join('\n'));
      assert.ok(block.includes('enabled = ' + playwrightMcpEnabled));
      assert.equal(patched.text.split(EXCLUDED).length, 2, 'once');
    }
    // a home written before gets the line once, then stays unchanged
    const before = 'model = "gpt-5"\n\n[mcp_servers.playwright]\ncommand = "/agents/codex/npm/bin/npx"\nargs = []\nstartup_timeout_sec = 30\nenabled = true\n';
    const updated = patchCodexPlaywrightMcpConfigText(before, { viewerDebugPort: 45678, codexHomeScope: 'conversation' }, '/agents/codex');
    assert.equal(updated.status, 'updated');
    assert.equal(updated.text.split(EXCLUDED).length, 2);
    assert.equal(patchCodexPlaywrightMcpConfigText(updated.text, { viewerDebugPort: 45678, codexHomeScope: 'conversation' }, '/agents/codex').status, 'unchanged');
  });
});

function vibeConfig(playwright) {
  let text = '';
  withGlobals({
    writeTextFile: (_file, value) => { text = String(value); },
    ensureDirectory: () => {},
    vibePlaywrightServer: () => playwright
  }, () => writeLocalVibeConfig('/managed/vibe-home', 'http://localhost:18080/convertigo/api/mcp', 'glm-5-3', { vibeProfile: 'mistral', model: 'glm-5-3' }));
  return text;
}

test('Vibe: the playwright server of config.toml leaves the tool out', () => {
  const text = vibeConfig({ command: '/usr/bin/node', args: ['/agents/vibe/npm/node_modules/@playwright/mcp/cli.js', '--cdp-endpoint', 'http://127.0.0.1:45678', '--shared-browser-context'] });
  const block = tomlBlock(text, '[[mcp_servers]]');
  assert.equal(block[0], 'name = "playwright"');
  // in the server entry itself, before its [mcp_servers.env] table
  assert.ok(block.includes(EXCLUDED), block.join('\n'));
  assert.equal(text.split(EXCLUDED).length, 2, 'the Convertigo server keeps all its tools');
  // without the Playwright server, nothing is left out
  assert.doesNotMatch(vibeConfig(null), /browser_run_code_unsafe/);
  // a home written before the exclusion is written again once: its recorded intent lacks the field, which belongs to
  // the MCP part of the intent (the descriptor cache Vibe keyed on the previous playwright entry is pruned)
  assert.equal(VIBE_CONFIG_MCP_INTENT_KEYS.playwrightDisabledTools, true);
  assert.match(source('vibe'), /if \(expectedPlaywright !== null\) \{\n\s*intentFields\.playwrightDisabledTools = PLAYWRIGHT_MCP_EXCLUDED_TOOLS\.join\(","\);\n\s*\}/);
});

test('the provider runtime denies the tool of its playwright server', () => {
  const command = claudeCommand({ claudePath: '/managed/claude', mcpConfigFile: '/home/convertigo-mcp.json', workspaceRoot: '/ws', cwd: '/ws' }, {});
  const at = command.indexOf('--disallowedTools');
  assert.ok(at > command.indexOf('--strict-mcp-config'), command.join(' '));
  assert.equal(command[at + 1], 'mcp__playwright__browser_run_code_unsafe');
  assert.equal(command.filter((arg) => arg === '--disallowedTools').length, 1);
  // the server of convertigo-mcp.json the names refer to
  assert.match(source('claude'), /servers\.playwright = playwright;/);
  // without the MCP config file there is no playwright server: nothing to deny
  assert.equal(claudeCommand({ claudePath: '/managed/claude', workspaceRoot: '/ws', cwd: '/ws' }, {}).indexOf('--disallowedTools'), -1);
});

test('no instruction text recommends browser_run_code_unsafe; proofs use browser-verify or the dedicated tools', () => {
  const savedFlow = global.flowCapabilityAvailable;
  const savedSystem = global.System;
  global.flowCapabilityAvailable = () => true;
  try {
    for (const port of [null, '45678']) {
      // the Electron Studio names its agent browser in convertigo.studio.cdp.port
      global.System = { getProperty: (name) => (name === 'convertigo.studio.cdp.port' ? port : null), getenv: () => null, currentTimeMillis: () => 0 };
      const texts = {
        'codex': agentSkillInstructions('codex', ''),
        'vibe': agentSkillInstructions('vibe', 'generalist'),
        'codex flow': agentSkillInstructions('codex', 'flow'),
        'vibe flow': agentSkillInstructions('vibe', 'flow'),
        'codex nocode': agentSkillInstructions('codex', 'nocode'),
        'vibe nocode': agentSkillInstructions('vibe', 'nocode'),
        'provider runtime': claudeInstructions({ cwd: '/w' }, 'generalist'),
        'provider runtime nocode': claudeInstructions({ cwd: '/w' }, 'nocode'),
        'provider runtime flow': claudeFlowInstructions({ cwd: '/w' }),
        'vibe flow-only home': vibeFlowFacadeAgents('http://localhost:18080/convertigo/api/flow-mcp'),
        'agent browser turn': withStudioAgentBrowserPrompt('Build the app', 'http://127.0.0.1:45678')
      };
      for (const [label, text] of Object.entries(texts)) {
        assert.doesNotMatch(text, /run_code/, label + ' (port ' + port + ')');
        assert.doesNotMatch(text, /\.playwright-mcp\/scripts/, label);
      }
      for (const label of ['codex flow', 'vibe flow']) {
        assert.match(texts[label], /For a functional proof \(a login, a path through pages, a form, the values to check\), drive the viewer with the dedicated Playwright tools: `browser_navigate` to the page, `browser_snapshot` for the element refs, `browser_fill_form` to fill a whole form in one call, `browser_click`, `browser_type`, `browser_evaluate` to read several values in one call, and `browser_take_screenshot` with `filename:"\.playwright-mcp\/<page>\.png"` at each page\./, label);
        assert.doesNotMatch(texts[label], /browser-verify/, label + ': Flow does not use the legacy MCP tool');
      }
      for (const label of ['codex', 'vibe']) {
        assert.match(texts[label], /Delegate each functional and visual browser proof/, label);
        assert.match(texts[label], /Without `browser-verify`, prove each path with the dedicated Playwright tools: `browser_navigate`/, label);
      }
      for (const label of ['codex', 'vibe', 'codex flow', 'provider runtime', 'provider runtime flow']) {
        assert.match(texts[label], /a file to upload with `browser_file_upload` goes in the temporary folder of this conversation/, label);
        assert.match(texts[label], /browser_evaluate/, label + ': browser_evaluate stays');
      }
    }
  } finally {
    global.flowCapabilityAvailable = savedFlow;
    global.System = savedSystem;
  }
});
