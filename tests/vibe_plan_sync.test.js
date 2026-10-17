// Plan sync hook: the Bridge installs it in hooks.toml of every Vibe home; the hook reminds the agent to rewrite its
// todo list. node --test tests/vibe_plan_sync.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const javaProxy = new Proxy(function(){},{get(_t,p){if(p===Symbol.toPrimitive)return ()=>'';return javaProxy;},apply(){return javaProxy;},construct(){return javaProxy;}});
global.Packages=javaProxy;global.context=javaProxy;global.C8O={agentBridge:{}};
vm.runInThisContext(fs.readFileSync(path.join(__dirname,'../js/agent_bridge_common.js'),'utf8'));
const HOOK = path.join(__dirname, '../hooks/vibe_plan_sync.py');

test('the managed block is added, replaced in place and removed, other hooks are kept', () => {
  const block = vibePlanSyncHookBlock('/ws/agents/vibe/.venv/bin/python', "/ws/home/it's/hooks/convertigo_plan_sync.py");
  assert.match(block, /^# BEGIN convertigo-plan-sync/);
  assert.match(block, /type = "post_tool"/);
  assert.match(block, /command = "'\/ws\/agents\/vibe\/.venv\/bin\/python' '\/ws\/home\/it'\\\\''s\/hooks\/convertigo_plan_sync.py'"/, 'shell-quoted, then TOML-escaped');
  const user = '[[hooks]]\nname = "lint"\ntype = "post_agent"\ncommand = "eslint ."\n';
  const added = mergeVibePlanSyncHook(user, block);
  assert.ok(added.startsWith(user.trim()));
  assert.equal(added.split('# BEGIN convertigo-plan-sync').length, 2);
  const other = vibePlanSyncHookBlock('/other/python', '/other/hook.py');
  const replaced = mergeVibePlanSyncHook(added, other);
  assert.equal(replaced.split('# BEGIN convertigo-plan-sync').length, 2, 'never two managed blocks');
  assert.match(replaced, /\/other\/python/);
  assert.doesNotMatch(replaced, /\.venv\/bin\/python/);
  assert.match(replaced, /name = "lint"/);
  assert.equal(mergeVibePlanSyncHook(mergeVibePlanSyncHook('', block), block), mergeVibePlanSyncHook('', block), 'idempotent');
  assert.equal(mergeVibePlanSyncHook(replaced, '').trim(), user.trim(), 'removal leaves the user hooks');
  assert.equal(mergeVibePlanSyncHook('', ''), '');
});

const python = ['python3', 'python'].find((cmd) => spawnSync(cmd, ['--version']).status === 0);

function runHook(event, env) {
  const out = spawnSync(python, ['-I', HOOK], { input: typeof event === 'string' ? event : JSON.stringify(event), env: Object.assign({}, process.env, env || {}) });
  assert.equal(out.status, 0, String(out.stderr));
  const text = String(out.stdout).trim();
  return text ? JSON.parse(text).hook_specific_output.additional_context : null;
}

test('the hook reminds after a second PROGRESS.md write or many calls without a todo write', { skip: !python && 'no python' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-sync-'));
  const session = path.join(dir, 'session'); const project = path.join(dir, 'project');
  fs.mkdirSync(session); fs.mkdirSync(path.join(project, 'docs/generated'), { recursive: true });
  fs.writeFileSync(path.join(project, 'docs/generated/PROGRESS.md'), '# PROGRESS\n## État\n- x\n## Lots\n- Lot 0 : DONE.\n- Lot 1 : DONE.\n- Lot 2 : en cours.\n## Prochains pas\n1. y\n');
  const ev = (tool_name, tool_input, extra) => Object.assign({ hook_event_name: 'post_tool', session_id: 's', transcript_path: session, cwd: project, tool_name, tool_input, tool_status: 'success' }, extra || {});
  const env = { CONVERTIGO_PLAN_SYNC_EVERY: '4' };
  const progress = { file_path: 'docs/generated/PROGRESS.md', content: 'x' };

  assert.equal(runHook(ev('vibe.todo', { action: 'write', todos: [{ id: '1', content: 'Lot 0', status: 'completed' }, { id: '2', content: 'Lot 1', status: 'in_progress' }] }), env), null);
  assert.equal(runHook(ev('file_system.write_file', progress), env), null, 'the first PROGRESS.md write after a todo write is the expected step');
  const second = runHook(ev('file_system.search_replace', { file_path: path.join(project, 'docs/generated/PROGRESS.md'), old_string: 'a', new_string: 'b' }), env);
  assert.match(second, /You just updated PROGRESS\.md/);
  assert.match(second, /- \[in_progress\] Lot 1/, 'quotes the last todo list');
  assert.match(second, /## Lots\n- Lot 0 : DONE\.\n- Lot 1 : DONE\.\n- Lot 2 : en cours\./, 'quotes the Lots section only');
  assert.doesNotMatch(second, /Prochains pas/);

  assert.equal(runHook(ev('mcp_Convertigo.batch_call', {}), env), null);
  assert.equal(runHook(ev('mcp_Convertigo.batch_call', {}), env), null);
  assert.equal(runHook(ev('mcp_Convertigo.batch_call', {}), env), null);
  assert.match(runHook(ev('mcp_Convertigo.batch_call', {}), env), /6 tool calls since your last `todo` write/);
  assert.equal(runHook(ev('file_system.bash', { command: 'cat docs/generated/PROGRESS.md' }), env), null, 'reading PROGRESS.md is not writing it');

  assert.equal(runHook(ev('vibe.todo', { action: 'read' }), env), null);
  assert.equal(runHook(ev('vibe.todo', { action: 'write', todos: [] }, { tool_status: 'failure' }), env), null);
  const state = JSON.parse(fs.readFileSync(path.join(session, 'convertigo-plan-sync.json'), 'utf8'));
  assert.equal(state.callsSinceTodo, 7, 'a todo read or a failed write is not a todo write');
  runHook(ev('vibe.todo', { action: 'write', todos: [{ id: '3', content: 'Lot 2', status: 'in_progress' }] }), env);
  assert.equal(runHook(ev('file_system.bash', { command: "echo '- Lot 2 : DONE.' >> docs/generated/PROGRESS.md" }), env), null);
  assert.equal(JSON.parse(fs.readFileSync(path.join(session, 'convertigo-plan-sync.json'), 'utf8')).progressSinceTodo, true, 'a shell write counts');
});

test('a broken event never changes the tool result', { skip: !python && 'no python' }, () => {
  assert.equal(runHook('not json'), null);
  assert.equal(runHook({ tool_name: 'vibe.todo' }), null, 'no session directory');
  assert.equal(runHook({ transcript_path: '/nonexistent/x', tool_name: 'file_system.write_file', tool_input: { file_path: 'PROGRESS.md' } }), null);
});
