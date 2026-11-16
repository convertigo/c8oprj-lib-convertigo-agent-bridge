// The edit profile of a Studio conversation (editProfile: yaml or html, "" for the default MCP tools), for the A/B of the
// surfaces an agent changes a project with. In a Vibe conversation with a home of its own, the profile is the
// X-Convertigo-Edit-Profile header of its MCP server (config.toml and the ACP session server), the permission tables of
// write_file and edit (refused outside the project files of the profile) and a section of its AGENTS.md; a change of
// profile is a change of tool policy (the config is written again, the process restarts on its session). Without a
// profile nothing changes.
// node --test tests/edit_profile.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const javaProxy = new Proxy(function(){},{get(_t,p){if(p===Symbol.toPrimitive)return ()=>'';if(p==='isFile'||p==='isDirectory'||p==='exists')return ()=>false;return javaProxy;},apply(){return javaProxy;},construct(){return javaProxy;}});
global.Packages=javaProxy;global.context=javaProxy;global.request=javaProxy;global.log=javaProxy;global.C8O={agentBridge:{}};
for(const name of ['common','codex','vibe','claude'])vm.runInThisContext(fs.readFileSync(path.join(root,'js/agent_bridge_'+name+'.js'),'utf8'),{filename:'agent_bridge_'+name+'.js'});
tigoVibeServers = () => [];
// the Studio is not read only, the project folders are known, the workspace is /ws
studioWriteConfirmMode = () => 'off';
projectDirectoryByName = (name) => (name === 'SalesPipeline' || name === 'Other' ? { path: '/ws/projects/' + name } : null);
filePath = (file) => (file && file.path ? file.path : String(file || ''));
childPath = (parent, name) => String(parent).replace(/\/+$/, '') + '/' + name;
resolveWorkspaceRoot = () => '/ws';

const studio = (extra) => Object.assign({ userId: 'studio', conversationId: 'agent-1', viewerDebugPort: 45991, projectId: 'SalesPipeline' }, extra || {});
const named = (headers, name) => headers.filter((h) => h.name === name).map((h) => h.value);
const sessionHeaders = (options) => buildMcpServers('http://localhost:18112/convertigo/api/mcp', options)[0].headers;

// config.toml of a Studio home after lib_ConvertigoMCP._setupVibe (its file tools "always")
const SETUP_VIBE_CONFIG = [
  'enabled_skills = ["convertigo-vibe-generalist"]',
  '',
  '[[mcp_servers]]',
  'name = "Convertigo"',
  'transport = "http"',
  '',
  '[tools.skill]',
  'permission = "always"',
  '',
  '[tools.bash]',
  'permission = "always"',
  '',
  '[tools.write_file]',
  'permission = "always"',
  '',
  '[tools.edit]',
  'permission = "always"',
  '',
  '[tools.Convertigo_project-lint]',
  'permission = "always"',
  ''
].join('\n');

test('only a Studio conversation with a home of its own takes a profile, and only yaml or html', () => {
  assert.equal(conversationEditProfile(studio({ editProfile: 'yaml' })), 'yaml');
  assert.equal(conversationEditProfile(studio({ editProfile: ' HTML ' })), 'html');
  assert.equal(conversationEditProfile(studio({ editProfile: 'mcp' })), '');
  assert.equal(conversationEditProfile(studio({ editProfile: '' })), '');
  assert.equal(conversationEditProfile(studio()), '');
  assert.equal(conversationEditProfile(studio({ editProfile: 'yaml', viewerDebugPort: 0 })), '', 'a shared home never takes it');
  assert.equal(conversationEditProfile(studio({ editProfile: 'yaml', viewerDebugPort: 0, vibeHomeScope: 'conversation' })), 'yaml');
  assert.equal(conversationEditProfile({ userId: 'person@example.invalid', editProfile: 'yaml', viewerDebugPort: 45991 }), '', 'a No Code user never');
  // the Studio user is never No Code: a nocode profile asked for it stays generalist (agentCapabilityProfile)
  assert.equal(conversationEditProfile(studio({ editProfile: 'yaml', agentProfile: 'nocode' })), 'yaml');
});

test('without a profile, the MCP headers, the tool policy and the config of a Studio home are what they were', () => {
  const options = studio();
  assert.deepEqual(named(sessionHeaders(options), 'X-Convertigo-Edit-Profile'), []);
  assert.ok(!vibeConfigMcpHeaderLines(options).some((line) => /Edit-Profile/.test(line)));
  assert.equal(vibeToolPolicy(options), '');
  assert.equal(mergeVibeEditProfileConfig(SETUP_VIBE_CONFIG, '', []), SETUP_VIBE_CONFIG, 'a home that never had a profile is left as it is');
  const agents = '# Convertigo Vibe Workspace\n\n- x\n\n' + VIBE_COMPACTION_RULES;
  assert.equal(mergeVibeEditProfileAgents(agents, ''), agents.replace(/\r\n?/g, '\n'));
});

test('the profile reaches the MCP as a header of the conversation: config.toml and the ACP session server', () => {
  assert.deepEqual(named(sessionHeaders(studio({ editProfile: 'yaml' })), 'X-Convertigo-Edit-Profile'), ['yaml']);
  assert.deepEqual(named(sessionHeaders(studio({ editProfile: 'html' })), 'X-Convertigo-Edit-Profile'), ['html']);
  assert.ok(vibeConfigMcpHeaderLines(studio({ editProfile: 'yaml' })).indexOf('"X-Convertigo-Edit-Profile" = "yaml"') >= 0);
  // the other headers stay
  assert.deepEqual(named(sessionHeaders(studio({ editProfile: 'yaml' })), 'X-Convertigo-Conversation-Id'), ['agent-1']);
});

test('a change of profile is a change of tool policy: the config is written again and the process restarts', () => {
  assert.equal(vibeToolPolicy(studio({ editProfile: 'yaml' })), 'studio-edit-yaml-v1:SalesPipeline');
  assert.equal(vibeToolPolicy(studio({ editProfile: 'html' })), 'studio-edit-html-v1:SalesPipeline');
  assert.equal(vibeToolPolicy(studio({ editProfile: 'yaml', projectId: 'Other' })), 'studio-edit-yaml-v1:Other');
  // read only wins: no writer at all
  studioWriteConfirmMode = () => 'readonly';
  try {
    assert.equal(vibeToolPolicy(studio({ editProfile: 'yaml' })), 'studio-readonly-v1');
  } finally {
    studioWriteConfirmMode = () => 'off';
  }
  assert.ok(VIBE_CONFIG_MCP_INTENT_KEYS.editProfile, 'the header is part of the MCP entry Vibe keys its descriptor cache on');
});

test('yaml lets the file tools write the project YAML and js only; html the generated app files only', () => {
  assert.deepEqual(vibeEditProfileGrants(studio(), 'yaml'), [
    'vibe-path:exact:/ws/projects/SalesPipeline/c8oProject.yaml',
    'vibe-path:directory_recursive:/ws/projects/SalesPipeline/_c8oProject',
    'vibe-path:directory_recursive:/ws/projects/SalesPipeline/js',
    'vibe-path:directory_recursive:/ws/.agent-tmp'
  ]);
  assert.deepEqual(vibeEditProfileGrants(studio(), 'html'), [
    'vibe-path:directory_recursive:/ws/projects/SalesPipeline/_private/ionic/src/app',
    'vibe-path:directory_recursive:/ws/.agent-tmp'
  ]);
});

test('the file tool tables of a profile replace the Studio ones, idempotently, and go back without it', () => {
  const grants = vibeEditProfileGrants(studio(), 'yaml');
  const yaml = mergeVibeEditProfileConfig(SETUP_VIBE_CONFIG, 'yaml', grants);
  const tables = vibeFileToolTables(yaml).tables;
  assert.equal(tables.write_file.permission, 'never');
  assert.deepEqual(tables.write_file.allowlist, grants);
  assert.equal(tables.edit.permission, 'never');
  assert.deepEqual(tables.edit.allowlist, grants);
  // the other tables stay, once each
  assert.equal((yaml.match(/\[tools\.write_file\]/g) || []).length, 1);
  assert.match(yaml, /\[tools\.bash\]\npermission = "always"/);
  assert.match(yaml, /\[tools\.Convertigo_project-lint\]\npermission = "always"/);
  assert.equal(mergeVibeEditProfileConfig(yaml, 'yaml', grants), yaml, 'written once');
  // Vibe rewrites config.toml with multi-line arrays: still the same tables
  const vibeRewritten = yaml.replace(/allowlist = \[([^\]]*)\]/g, (_m, body) => 'allowlist = [\n' + body.split(', ').map((g) => '    ' + g + ',').join('\n') + '\n]');
  assert.notEqual(vibeRewritten, yaml);
  assert.equal(mergeVibeEditProfileConfig(vibeRewritten, 'yaml', grants), vibeRewritten);
  // another profile replaces them
  const html = mergeVibeEditProfileConfig(yaml, 'html', vibeEditProfileGrants(studio(), 'html'));
  assert.deepEqual(vibeFileToolTables(html).tables.write_file.allowlist, vibeEditProfileGrants(studio(), 'html'));
  // back to the default: the Studio's tables again
  const back = mergeVibeEditProfileConfig(html, '', []);
  assert.equal(vibeFileToolTables(back).tables.write_file.permission, 'always');
  assert.equal(vibeFileToolTables(back).tables.edit.permission, 'always');
  assert.deepEqual(vibeFileToolTables(back).tables.write_file.allowlist, []);
  assert.equal(mergeVibeEditProfileConfig(back, '', []), back);
});

test('the instructions of a profile are a section of AGENTS.md, before the compaction rules, removed without it', () => {
  const agents = '# Convertigo Vibe Workspace\n\n- Do not edit generated Convertigo artifacts.\n\n' + VIBE_COMPACTION_RULES;
  const projects = [{ name: 'SalesPipeline', dir: '/ws/projects/SalesPipeline' }];
  const yamlSection = vibeEditProfileSection('yaml', projects);
  assert.match(yamlSection, /convertigo:\/\/resources\/convertigo-yaml-editing/);
  assert.match(yamlSection, /\/ws\/projects\/SalesPipeline/);
  assert.match(yamlSection, /trailing space/);
  assert.match(vibeEditProfileSection('html', projects), /convertigo:\/\/resources\/convertigo-ngx-html-roundtrip/);
  assert.match(vibeEditProfileSection('html', projects), /fromIonic:true/);
  const withYaml = mergeVibeEditProfileAgents(agents, yamlSection);
  assert.ok(withYaml.indexOf(VIBE_EDIT_PROFILE_HEADING) < withYaml.indexOf(VIBE_COMPACTION_RULES_HEADING));
  assert.equal(mergeVibeEditProfileAgents(withYaml, yamlSection), withYaml, 'written once');
  const withHtml = mergeVibeEditProfileAgents(withYaml, vibeEditProfileSection('html', projects));
  assert.equal((withHtml.match(new RegExp(VIBE_EDIT_PROFILE_HEADING.replace(/[()]/g, '\\$&'), 'g')) || []).length, 1);
  assert.doesNotMatch(withHtml, /convertigo-yaml-editing/);
  const back = mergeVibeEditProfileAgents(withHtml, '');
  assert.equal(back.indexOf(VIBE_EDIT_PROFILE_HEADING), -1);
  assert.ok(back.indexOf(VIBE_COMPACTION_RULES_HEADING) > 0);
});

test('the Studio home is set up with the profile after _setupVibe and the Flow pack, and the start sequences pass it', () => {
  const common = fs.readFileSync(path.join(root, 'js/agent_bridge_common.js'), 'utf8');
  assert.match(common, /studioReport = syncVibeFlowPack\(options, new File\(home\), studioMcpEndpoint, studioReport\);\n\s+\/\/ [^\n]+\n\s+return syncVibeEditProfile\(options, new File\(home\), studioReport\);/);
  const vibe = fs.readFileSync(path.join(root, 'js/agent_bridge_vibe.js'), 'utf8');
  assert.match(vibe, /editProfile: options\.editProfile,/);
  assert.match(vibe, /intentFields\.editProfile = conversationEditProfile\(options\);/);
  for (const sequence of ['agent_vibe_start', 'agent_vibe_setup']) {
    const yaml = fs.readFileSync(path.join(root, '_c8oProject/sequences/' + sequence + '.yaml'), 'utf8');
    assert.match(yaml, /editProfile: typeof editProfile === "undefined" \? "" : editProfile,/, sequence);
    assert.match(yaml, /↓editProfile \[variables\.RequestableVariable-\d+\]: \n/, sequence);
  }
});
