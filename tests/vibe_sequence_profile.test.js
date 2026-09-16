const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');

// Convertigo includeInScope evaluates included files in the request scope,
// even when include() is called from an IIFE. Do not call helpers in isolation.
function loadSequence(name, input, requestValue = '') {
  const javaStub = new Proxy(function () {}, {
    get(_target, key) {
      if (key === Symbol.toPrimitive) return () => '';
      if (['isFile', 'isDirectory', 'exists'].includes(key)) return () => false;
      return javaStub;
    },
    apply() { return javaStub; }, construct() { return javaStub; }
  });
  const sandbox = { Packages: javaStub, log: javaStub,
    context: { httpServletRequest: { getParameter: key => key === 'vibeProfile' ? requestValue : '' } }
  };
  if (input !== undefined) sandbox.vibeProfile = input;
  const scope = vm.createContext(sandbox);
  let captured;
  sandbox.include = file => {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), scope, { filename: file });
    if (file === 'js/vibe_agent_bridge.js') {
      for (const method of ['vibeSetup', 'vibeStart', 'settings']) {
        sandbox.C8O.agentBridge[method] = options => { captured = options; return {}; };
      }
    }
  };
  const yaml = fs.readFileSync(path.join(root, '_c8oProject/sequences', name + '.yaml'), 'utf8');
  const raw = yaml.match(/  expression: \|\n([\s\S]*?)(?=\n↓)/)[1].replace(/^    /gm, '').trim();
  const code = raw.startsWith("'") ? raw.slice(1, -1).replace(/''/g, "'") : raw;
  vm.runInContext(code, scope, { filename: name });
  assert.ok(captured);
  return { captured, scope };
}

for (const sequence of ['agent_vibe_setup', 'agent_vibe_start', 'agent_settings']) {
  test(sequence + ' preserves the public profile through the real script loader', () => {
    for (const input of ['convertigo', 'mistral', 'gateway', '', undefined]) {
      const { captured, scope } = loadSequence(sequence, input);
      assert.equal(captured.vibeProfile, input || '', 'include must not overwrite request variables');
      scope.received = captured;
      const actual = vm.runInContext('resolveVibeProfile(optionsWithRequestFallbacks(received))', scope);
      assert.equal(actual, ['convertigo', 'gateway'].includes(input) ? 'convertigo' : 'mistral');
    }
  });
}

test('HTTP fallback retains Convertigo mode when no sequence variable is populated', () => {
  const { captured, scope } = loadSequence('agent_vibe_setup', undefined, 'convertigo');
  assert.equal(captured.vibeProfile, '');
  scope.received = captured;
  assert.equal(vm.runInContext('resolveVibeProfile(optionsWithRequestFallbacks(received))', scope), 'convertigo');
});
