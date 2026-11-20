// The instructions of a No Code session carry the core of the No Code form contract, so that the agent does not spend a
// step on nocode-form-contract-get. The text is built once per contract version and read back as is: every conversation
// gets the same bytes, which keeps the provider's prompt cache warm. A symbol turns it off; a failure leaves it out.
// node --test tests/nocode_contract_preload.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');

let symbols = {};
function javaProxyWith() {
  const proxy = new Proxy(function () {}, {
    get(_t, p) {
      if (p === Symbol.toPrimitive) return () => '';
      if (p === 'symbolsGetValue') return (name) => (Object.prototype.hasOwnProperty.call(symbols, name) ? symbols[name] : null);
      return proxy;
    },
    apply() { return proxy; },
    construct() { return proxy; }
  });
  return proxy;
}
global.Packages = javaProxyWith();
global.context = global.Packages;
global.C8O = { agentBridge: {} };
for (const name of ['common', 'codex', 'claude']) vm.runInThisContext(fs.readFileSync('js/agent_bridge_' + name + '.js', 'utf8'));

// a small java.io.File over the real disk
class FakeFile {
  constructor(parent, child) {
    this.path = child === undefined ? String(parent) : path.join(parent instanceof FakeFile ? parent.path : String(parent), String(child));
  }
  isFile() { return fs.existsSync(this.path) && fs.statSync(this.path).isFile(); }
  getParentFile() { return new FakeFile(path.dirname(this.path)); }
  toString() { return this.path; }
}

const contract = {
  contractVersion: '2026-11-19.c8oforms-v27+mcp-2026-11-19',
  quickReference: { forms: 'page > components', ids: 'unique' },
  sectionIndex: ['components', 'formulas'],
  types: ['text', 'number'],
  aliases: { input: 'text' },
  capabilities: { styleModel: true },
  moreSections: 'ask nocode-form-contract-get with sections',
  sections: { components: 'not part of the core' }
};

function withAgents(fn) {
  const saved = {
    File: global.File, agentsDirectory: global.agentsDirectory, resolveWorkspaceRoot: global.resolveWorkspaceRoot,
    callLocalSequence: global.callLocalSequence, readTextFile: global.readTextFile, writeTextFile: global.writeTextFile
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nocode-contract-preload-'));
  const io = { calls: 0, writes: 0, response: { document: { result: contract } } };
  global.File = FakeFile;
  global.resolveWorkspaceRoot = () => root;
  global.agentsDirectory = (workspaceRoot) => new FakeFile(workspaceRoot, 'agents');
  global.callLocalSequence = (project, sequence) => {
    io.calls++;
    assert.equal(project, 'lib_ConvertigoMCP');
    assert.equal(sequence, 'tools_nocode_form_contract_get');
    if (io.response instanceof Error) throw io.response;
    return io.response;
  };
  global.readTextFile = (file) => fs.readFileSync(file.path, 'utf8');
  global.writeTextFile = (file, text) => {
    io.writes++;
    fs.mkdirSync(path.dirname(file.path), { recursive: true });
    fs.writeFileSync(file.path, text, 'utf8');
  };
  try {
    fn(io, path.join(root, 'agents', 'nocode', 'contract-core'));
  } finally {
    Object.assign(global, saved);
    symbols = {};
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('the No Code instructions end with the contract core, the same bytes on every call', () => {
  withAgents((io, dir) => {
    const first = agentSkillInstructions('vibe', 'nocode', {});
    const marker = '\n## No Code form contract core (' + contract.contractVersion + ')\n';
    assert.ok(first.includes('Provider: '), 'the usual instructions are kept');
    const section = first.slice(first.indexOf(marker));
    assert.ok(first.endsWith(section) && section.length > marker.length, 'the core is the last section');
    assert.match(section, /do not call nocode-form-contract-get for it; ask only for a section you need/);
    const json = JSON.parse(section.split('```json\n')[1].split('\n```')[0]);
    assert.deepEqual(Object.keys(json), ['contractVersion', 'capabilities', 'quickReference', 'types', 'aliases', 'sectionIndex', 'moreSections'], 'fixed key order');
    assert.equal(json.sections, undefined, 'sections stay behind nocode-form-contract-get');

    const file = path.join(dir, contract.contractVersion.replace(/[^A-Za-z0-9._+-]/g, '_') + '.md');
    assert.equal(fs.readFileSync(file, 'utf8'), section, 'kept once per contract version');
    assert.equal(io.writes, 1);

    // a later conversation reads the kept text back, even if the contract answers its keys in another order
    io.response = { document: { result: Object.fromEntries(Object.entries(contract).reverse()) } };
    assert.equal(agentSkillInstructions('vibe', 'nocode', {}), first);
    assert.equal(agentSkillInstructions('codex', 'nocode').endsWith(section), true, 'Codex homes get it too');
    assert.equal(io.writes, 1, 'not written again');

    // a damaged file is rebuilt
    fs.writeFileSync(file, 'truncated', 'utf8');
    assert.equal(agentSkillInstructions('vibe', 'nocode', {}), first);
    assert.equal(io.writes, 2);
  });
});

test('other profiles do not ask for the contract', () => {
  withAgents((io) => {
    agentSkillInstructions('vibe', 'generalist', {});
    agentSkillInstructions('codex', '');
    assert.equal(io.calls, 0);
  });
});

test('assistant.nocode.contract_preload=false leaves the core out', () => {
  withAgents((io) => {
    symbols['assistant.nocode.contract_preload'] = ' FALSE ';
    const text = agentSkillInstructions('vibe', 'nocode', {});
    assert.doesNotMatch(text, /No Code form contract core/);
    assert.match(text, /Provider: /);
    assert.equal(io.calls, 0);
  });
});

test('no contract, a failed call or an oversized contract give the instructions without it', () => {
  withAgents((io) => {
    for (const response of [new Error('lib_ConvertigoMCP is not deployed'), null, { document: { result: { error: 'no contract' } } },
      { document: { result: { contractVersion: 'v1' } } },
      { document: { result: Object.assign({}, contract, { contractVersion: 'big', quickReference: 'x'.repeat(70000) }) } }]) {
      io.response = response;
      const text = agentSkillInstructions('vibe', 'nocode', {});
      assert.doesNotMatch(text, /No Code form contract core/);
      assert.match(text, /Provider: /);
    }
    assert.equal(io.writes, 0);
  });
});
