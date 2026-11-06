// A permission can arrive before the notification that names its tool.
// Keep this contract independent of CLI configuration and filesystem checks.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const java = new Proxy(function(){}, {get(_t,p){if(p===Symbol.toPrimitive)return ()=>'';return java;},apply(){return java;},construct(){return java;}});
const source = fs.readFileSync(process.env.BRIDGE_PERMISSION_SOURCE || path.join(__dirname,'../js/agent_bridge_common.js'),'utf8');
function harness(policy, cache) {
  const s = {Packages:java, context:java, C8O:{agentBridge:{}}};
  vm.createContext(s);vm.runInContext(source,s);
  const answers=[],events=[];
  s.sendJsonResponse = (_entry,_id,result) => answers.push(JSON.parse(JSON.stringify(result)));
  s.pushEvent = (_entry,type,data) => events.push({type,data});
  // The original witness created an empty title map without having a title to store.
  const entry = {noCodePolicy:policy};
  if(cache) entry.toolCallTitles={};
  return {s,entry,answers,events};
}
for(const policy of ['files','mcp-only']) for(const cache of [false,true]) {
  test(policy + ': permission before title is refused, empty title cache=' + cache, () => {
    const {s,entry,answers,events}=harness(policy,cache);
    s.handleAgentRequest(entry,{id:1,method:'session/request_permission',params:{toolCall:{toolCallId:'effect-not-yet-named'},options:[
      {optionId:'allow_once',kind:'allow_once'},{optionId:'reject_once',kind:'reject_once'}
    ]}});
    assert.deepEqual(answers[0].outcome,{outcome:'selected',optionId:'reject_once'});
    assert.equal(events.find(e=>e.type==='permission/refused').data.reason,'unknown_tool');
    assert.ok(!events.some(e=>e.type==='permission/selected'));
  });
}
test('a later recognized MCP title permits only the later request',()=>{
  const {s,entry,answers}=harness('mcp-only',false);
  const params={toolCall:{toolCallId:'effect-later'},options:[{optionId:'allow_once',kind:'allow_once'},{optionId:'reject_once',kind:'reject_once'}]};
  s.handleAgentRequest(entry,{id:1,method:'session/request_permission',params});
  s.rememberToolCallTitle(entry,'effect-later','mcp_Convertigo.nocode_form_get');
  s.handleAgentRequest(entry,{id:2,method:'session/request_permission',params});
  assert.equal(answers[0].outcome.optionId,'reject_once');
  assert.equal(answers[1].outcome.optionId,'allow_once');
});
test('the managed No Code ACP command cannot request blanket approval',()=>{
  const provider=fs.readFileSync(path.join(__dirname,'../js/agent_bridge_vibe.js'),'utf8');
  assert.doesNotMatch(provider,/--auto-approve|--yolo/);
  const config=source.slice(source.indexOf('function vibeToolPolicyLines('),source.indexOf('function vibeToolPolicyTables('));
  assert.match(config,/enable_auto_approve = false/);
  assert.match(config,/bypass_tool_permissions = false/);
});
for (const policy of ['files', 'mcp-only']) {
  for (const title of ['Reading convertigo_fixture/../outside', 'bash: convertigo_fixture', 'Fetching convertigo_https://fixture.invalid']) {
    test(policy + ': a native argument prefix cannot name an MCP tool: ' + title, () => {
      const {s,entry,answers}=harness(policy,false);
      s.rememberToolCallTitle(entry,'effect-native-prefix',title);
      s.handleAgentRequest(entry,{id:1,method:'session/request_permission',params:{toolCall:{toolCallId:'effect-native-prefix'},options:[{optionId:'allow_once',kind:'allow_once'},{optionId:'reject_once',kind:'reject_once'}]}});
      assert.equal(answers[0].outcome.optionId,'reject_once');
    });
  }
}
for (const kind of ['read','edit','execute','fetch']) {
  test('a known native ' + kind + ' cannot use an argument as an MCP-looking title',()=>{
    const {s,entry,answers}=harness('files',false);
    s.normalizeSessionUpdate(entry,{update:{sessionUpdate:'tool_call',toolCallId:'effect-argument-title',title:'convertigo_fixture',kind,status:'pending'}});
    s.handleAgentRequest(entry,{id:1,method:'session/request_permission',params:{toolCall:{toolCallId:'effect-argument-title'},options:[{optionId:'allow_once',kind:'allow_once'},{optionId:'reject_once',kind:'reject_once'}]}});
    assert.equal(answers[0].outcome.optionId,'reject_once');
  });
}
