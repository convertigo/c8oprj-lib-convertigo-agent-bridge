// A No Code agent whose model cannot see (GLM 5.3 through the Convertigo gateway) lost the images its user attached:
// the Bridge told it they were not sent. image-describe (lib_ConvertigoMCP) now describes each one on the user's gateway
// key, at most 3 in 45 s, and the description goes with the prompt; its calls count in the conversation's usage. A No
// Code session reads its user's attachments only: the path comes from the page.
// node --test tests/nocode_image_describe.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const javaProxy = new Proxy(function(){},{get(_t,p){if(p===Symbol.toPrimitive)return ()=>'';return javaProxy;},apply(){return javaProxy;},construct(){return javaProxy;}});
global.Packages=javaProxy;global.context=javaProxy;global.C8O={agentBridge:{}};
for(const name of ['common','codex','claude','vibe'])vm.runInThisContext(fs.readFileSync(path.join(root,'js/agent_bridge_'+name+'.js'),'utf8'));
const vibeSource = fs.readFileSync(path.join(root, 'js/agent_bridge_vibe.js'), 'utf8');
const commonSource = fs.readFileSync(path.join(root, 'js/agent_bridge_common.js'), 'utf8');

class FakeFile {
  constructor(parent, child) { this.p = child === undefined ? String(parent.p || parent) : path.join(String(parent.p || parent), String(child)); }
  getCanonicalPath() { return path.resolve(this.p); }
  getName() { return path.basename(this.p); }
  getPath() { return this.p; }
  toPath() { return this.p; }
  isFile() { return true; }
  length() { return 1000; }
}

function withFakes(fakes, run) {
  const saved = {};
  for (const [name, value] of Object.entries(fakes)) { saved[name] = global[name]; global[name] = value; }
  try { return run(); } finally { for (const [name, value] of Object.entries(saved)) global[name] = value; }
}

const slug = value => String(value).toLowerCase().replace(/[^a-z0-9_.-]/g, '_') + '--0123456789abcdef';
const entry = { noCode: true, ownerKey: 'forms@example.invalid', workspaceRoot: '/workspace', vibeHome: '/workspace/agents/vibe/homes/u', sessionId: 's1', model: 'glm-5-3' };
const mine = '/workspace/agents/convertigo/users/' + slug(entry.ownerKey);

test('a No Code session reads its user\'s attachments only', () => {
  withFakes({ File: FakeFile, userPathSlug: slug }, () => {
    assert.equal(noCodeAttachmentAllowed(entry, mine + '/conversations/agent-1/attachments/form.png'), true);
    assert.equal(noCodeAttachmentAllowed(entry, '/workspace/agents/attachments/' + slug(entry.ownerKey) + '/agent-1/scan.jpg'), true);
    assert.equal(noCodeAttachmentAllowed(entry, '/workspace/agents/convertigo/users/other--ffff/conversations/agent-9/attachments/x.png'), false, 'another user');
    assert.equal(noCodeAttachmentAllowed(entry, mine + '/conversations/agent-1/attachments/../../../../other--ffff/conversations/a/attachments/x.png'), false, 'no way out with ..');
    assert.equal(noCodeAttachmentAllowed(entry, '/workspace/agents/vibe/homes/u/logs/x.png'), false, 'not an attachment');
    assert.equal(noCodeAttachmentAllowed(entry, '/etc/x.png'), false);
    assert.equal(noCodeAttachmentAllowed(Object.assign({}, entry, { ownerKey: '' }), mine + '/conversations/a/attachments/x.png'), false);
  });
  const reads = [];
  const report = withFakes({ File: FakeFile, Files: { readAllBytes: file => { reads.push(file); return []; } } }, () =>
    vibeImageBlocks(JSON.stringify(['/other/user/x.png', mine + '/conversations/a/attachments/y.png']), 'glm-5-3', p => p.startsWith(mine)));
  assert.deepEqual(report.skipped.map(s => s.reason), ['not_allowed', 'model_without_vision']);
  assert.deepEqual(reads, [], 'a refused path is not read');
});

function fakeApi({ fail = [], slow = 0, clock } = {}) {
  const calls = [];
  return {
    calls,
    javaHost: () => ({ decodeBase64() {}, encodeBase64() {}, now: () => clock.now, post: () => ({}) }),
    run(params, host) {
      calls.push({ params, key: host.readKey() });
      clock.now += slow;
      const name = path.basename(params.path);
      if (fail.includes(name)) throw new Error('gateway refused');
      return { description: 'Form with fields Nom, Date (' + name + ')', model: 'mistral/mistral-large-4',
        usage: { tool: 'image-describe', callId: 'c-' + name, model: 'mistral/mistral-large-4', inputTokens: 900, outputTokens: 120, cost: 0.002 } };
    }
  };
}

function describe(skipped, options = {}) {
  const clock = { now: 0 };
  const api = options.api === null ? null : fakeApi(Object.assign({ clock }, options));
  const recorded = [];
  const report = withFakes({ File: FakeFile, now: () => clock.now }, () =>
    describeImagesForBlindModel(options.entry || entry, skipped, { api, key: options.key === undefined ? 'sk-user' : options.key, record: (e, usages) => recorded.push(...usages) }));
  return { report, calls: api ? api.calls : [], recorded };
}

const blind = name => ({ path: mine + '/conversations/a/attachments/' + name, reason: 'model_without_vision', model: 'glm-5-3' });

test('the images a blind No Code model cannot see are described with the user\'s key and go with the prompt', () => {
  const { report, calls, recorded } = describe([blind('paper-form.jpg'), { path: '/x.png', reason: 'not_found' }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].key, 'sk-user');
  assert.match(calls[0].params.question, /Transcribe every visible text exactly/);
  assert.deepEqual(report.described.map(d => d.name), ['paper-form.jpg']);
  assert.match(report.text, /Attached image "paper-form\.jpg": you cannot see images, so the Agent Bridge had it described by the vision model `mistral\/mistral-large-4`\. The description:\nForm with fields Nom, Date/);
  assert.deepEqual(recorded.map(u => u.callId), ['c-paper-form.jpg'], 'its call counts in the usage');
});

test('at most 3 images and 45 s per message; a refused image is reported, the others still described', () => {
  const many = describe([blind('1.png'), blind('2.png'), blind('3.png'), blind('4.png')]);
  assert.equal(many.calls.length, 3);
  assert.deepEqual(many.report.failed.map(f => f.name + ':' + f.reason), ['4.png:too_many']);
  const slow = describe([blind('1.png'), blind('2.png')], { slow: 46000 });
  assert.equal(slow.calls.length, 1);
  assert.deepEqual(slow.report.failed.map(f => f.reason), ['time']);
  const refused = describe([blind('bad.png'), blind('good.png')], { fail: ['bad.png'] });
  assert.deepEqual(refused.report.described.map(d => d.name), ['good.png']);
  assert.match(refused.report.failed[0].reason, /gateway refused/);
});

test('nothing is described in the Studio, without image-describe or without a gateway key', () => {
  assert.equal(describe([blind('a.png')], { entry: Object.assign({}, entry, { noCode: false }) }).calls.length, 0);
  assert.equal(describe([blind('a.png')], { api: null }).report.described.length, 0);
  assert.equal(describe([blind('a.png')], { key: '' }).calls.length, 0);
  assert.equal(describe([{ path: '/a.png', reason: 'too_large' }]).calls.length, 0);
});

test('vibePrompt filters a No Code session\'s paths, adds the descriptions and keeps the note for the images left', () => {
  assert.match(vibeSource, /entry\.noCode === true \? function \(path\) \{ return noCodeAttachmentAllowed\(entry, path\); \} : null\);/);
  assert.match(vibeSource, /var described = describeImagesForBlindModel\(entry, images\.skipped\);/);
  assert.match(vibeSource, /promptBlocks\[0\]\.text \+= described\.text;\n\s+images\.skipped = images\.skipped\.filter/);
  assert.match(vibeSource, /new File\(project\.getDirFile\(\), "js\/tools_image_describe\.js"\)/);
  assert.match(commonSource, /summed\[VIBE_DESCRIBED_IMAGES_FILE\] = described\.segment;/);
  assert.match(commonSource, /if \(typeof allowed === "function" && allowed\(candidate\) !== true\) \{\n\s+report\.skipped\.push\(\{ path: candidate, reason: "not_allowed" \}\);/);
});

test('the described images count once per call in the vision rows of the session usage', () => {
  const files = {};
  const usage = { tool: 'image-describe', callId: 'c1', model: 'mistral/mistral-large-4', inputTokens: 900, outputTokens: 120, cost: 0.002 };
  withFakes({ File: FakeFile, readJsonFile: file => files[file.p] || null, writeJsonFile: (file, value) => { files[file.p] = JSON.parse(JSON.stringify(value)); } }, () => {
    recordDescribedImagesUsage(entry, [usage]);
    recordDescribedImagesUsage(entry, [usage, Object.assign({}, usage, { callId: 'c2' })]);
  });
  const saved = files['/workspace/agents/vibe/homes/u/logs/session/unified/s1/convertigo-image-descriptions.json'];
  assert.ok(saved, Object.keys(files).join());
  const row = saved.segment.vision['mistral/mistral-large-4'];
  assert.equal(row.calls, 2, 'c1 counted once');
  assert.equal(row.inputTokens, 1800);
  assert.equal(Math.round(row.cost * 1000), 4);
  assert.deepEqual(saved.segment.visionCallIds, ['c1', 'c2']);
});
