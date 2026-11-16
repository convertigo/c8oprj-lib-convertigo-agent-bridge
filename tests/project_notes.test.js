// Agents rediscovered a project at each run: in the SalesPipeline runs of 16/11 one read for 6 to 8 minutes before its
// first edit. The notes it keeps with project-notes-write of lib_ConvertigoMCP (<project>/docs/generated/PROGRESS.md)
// now start each Studio turn about that project: the project selected in the panel and the workspace projects the user
// message names, once per agent process while they do not change, secrets masked, never in No Code nor for a slash
// command.
// node --test tests/project_notes.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const javaProxy = new Proxy(function(){},{get(_t,p){if(p===Symbol.toPrimitive)return ()=>'';return javaProxy;},apply(){return javaProxy;},construct(){return javaProxy;}});
global.Packages=javaProxy;global.context=javaProxy;global.request=javaProxy;global.log=javaProxy;global.C8O={agentBridge:{}};
for(const name of ['common','codex','vibe','claude'])vm.runInThisContext(fs.readFileSync(path.join(root,'js/agent_bridge_'+name+'.js'),'utf8'),{filename:'agent_bridge_'+name+'.js'});
const source = (name) => fs.readFileSync(path.join(root, 'js/agent_bridge_' + name + '.js'), 'utf8');

const PROJECTS = ['SalesPipeline', 'PipelineCrm', 'PipelineCrm3', 'lib_ConvertigoMCP', 'mobilebuilder_tpl_8_4_0_ngx', 'Crm'];
const prompt = (user) => 'You are Tigo.\n- Selected project: (none)\n\nUser message:\n' + user;

test('the projects of a turn: the selected one, then the ones the user message names as whole words', () => {
  assert.deepEqual(projectsOfTurn(prompt('Dans la page Companies du projet SalesPipeline, ajoute une colonne'), '', PROJECTS), ['SalesPipeline']);
  assert.deepEqual(projectsOfTurn(prompt('Compare PipelineCrm3 with SalesPipeline'), '', PROJECTS), ['PipelineCrm3', 'SalesPipeline'],
    'in the order the message names them, PipelineCrm3 is not PipelineCrm');
  assert.deepEqual(projectsOfTurn(prompt('Fix the login'), 'SalesPipeline', PROJECTS), ['SalesPipeline'], 'the panel selection');
  assert.deepEqual(projectsOfTurn(prompt('Use lib_ConvertigoMCP and mobilebuilder_tpl_8_4_0_ngx'), 'lib_ConvertigoMCP', PROJECTS), [],
    'never the Tigo libraries nor the templates');
  assert.deepEqual(projectsOfTurn(prompt('A CRM for my team'), '', PROJECTS), [], 'case matters: CRM is not the project Crm');
  // the preamble of the Assistant names other projects; only the user message counts
  assert.deepEqual(projectsOfTurn('Project PipelineCrm3 was used before.\n\nUser message:\nAdd a page to SalesPipeline', '', PROJECTS), ['SalesPipeline']);
});

test('a section once per process while the notes do not change, masked and bounded', () => {
  const notes = { SalesPipeline: '# SalesPipeline\n- Styles: AppLayout holds the app-* classes.\n- Demo account demo@salespipeline.io (password given at hand-off)\n- password: Hunter2!\n- Authorization: Bearer abcdefghijklmnop12345\n' };
  const seen = {};
  const read = (name) => notes[name] || '';
  const first = projectNotesSection(prompt('Restyle the KPI cards of SalesPipeline'), '', PROJECTS, seen, read);
  assert.match(first, /^Project notes kept by Tigo/);
  assert.match(first, /### SalesPipeline \(docs\/generated\/PROGRESS\.md\)/);
  assert.match(first, /AppLayout holds the app-\* classes/);
  assert.match(first, /password given at hand-off/, 'words after password are not a value');
  assert.doesNotMatch(first, /Hunter2|abcdefghijklmnop12345/, 'secrets are masked');
  assert.equal(projectNotesSection(prompt('And the list page of SalesPipeline'), '', PROJECTS, seen, read), '', 'same notes, same process: not again');
  notes.SalesPipeline += '- KPI cards: one soft background per accent.\n';
  assert.match(projectNotesSection(prompt('Next change in SalesPipeline'), '', PROJECTS, seen, read), /one soft background per accent/, 'changed notes come again');
  notes.PipelineCrm3 = 'x'.repeat(9000);
  const long = projectNotesSection(prompt('Look at PipelineCrm3'), '', PROJECTS, {}, read);
  assert.ok(long.length < 4600, 'bounded');
  assert.match(long, /project-brief returns the whole notes/);
  assert.equal(projectNotesSection(prompt('Look at PipelineCrm'), '', PROJECTS, {}, read), '', 'a project without notes adds nothing');
});

test('no notes for a slash command, in No Code, or twice in one prompt', () => {
  const saved = { workspaceProjectNames: global.workspaceProjectNames, readProjectNotes: global.readProjectNotes };
  try {
    // the helpers the prefix uses read the engine; the section itself is tested above
    assert.equal(withProjectNotesPrompt('/compact', {}, {}), '/compact');
    assert.equal(withProjectNotesPrompt(prompt('SalesPipeline'), {}, { noCode: true }), prompt('SalesPipeline'));
    assert.equal(withProjectNotesPrompt(prompt('SalesPipeline'), {}, { skillProfile: 'nocode' }), prompt('SalesPipeline'));
    const already = 'Project notes kept by Tigo (…)\n\n' + prompt('SalesPipeline');
    assert.equal(withProjectNotesPrompt(already, {}, {}), already);
  } finally {
    Object.assign(global, saved);
  }
});

test('the three runtimes start their turns with the notes', () => {
  const vibe = source('vibe');
  const codex = source('codex');
  const claude = source('claude');
  assert.match(vibe, /promptText = withProjectNotesPrompt\(promptText, options, entry\);\n\s*promptText = withAgentTempDirPrompt/);
  // once for both Codex turn paths (app-server and exec), after the managed preflight
  assert.equal((codex.match(/withProjectNotesPrompt\(promptText, options, entry\)/g) || []).length, 1);
  assert.match(codex, /\n\s*promptText = withProjectNotesPrompt\(promptText, options, entry\);\n\s*var managedPreflight = \{/);
  // the provider runtime: not for a menu command
  assert.match(claude, /\} else \{\n\s*promptText = withAgentTempDirPrompt\(promptText, entry\.agentTempDir\);\n\s*promptText = withRevealModePrompt\([^\n]+\n\s*promptText = withProjectNotesPrompt\(promptText, options, entry\);\n\s*\}/);
});
