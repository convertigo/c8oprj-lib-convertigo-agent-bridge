const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const proxy=new Proxy(function(){},{get(_t,p){if(p===Symbol.toPrimitive)return()=>'';return proxy;},apply(){return proxy;},construct(){return proxy;}});
const sandbox={Packages:proxy,context:proxy,C8O:{agentBridge:{}}};vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(process.env.BRIDGE_COMMON_PATH || 'js/agent_bridge_common.js','utf8'),sandbox);
const line=(type,payload)=>JSON.stringify({type,payload});
const at=t=>line('core_input',{determinism:{time_unix_ms:t}});
const intent=(id,kind='tool')=>line('action_intent',{kind,action_id:id,request:{turn_id:'turn',call:{tool_name:'authoring_mutate'}}});
const result=(id,type,value)=>line('action_result',{action_id:id,result:{type,result:value}});
test('MCP errors wrapped in provider successes are counted as failed tools, without treating domain data as errors',()=>{
 let metrics=sandbox.emptyVibeMetrics();
 const values=[{isError:true,structuredContent:{error:{code:'INVALID_TARGET',message:'Unknown target'}}},
  {structured_content:{error:{code:'SQL_QUERY_BOUNDS',message:'limit'}}},
  {content:[{type:'text',text:'Error [INVALID_FLOW_NAME] Invalid Flow name'}]},
  {content:[{type:'text',text:JSON.stringify({result:{isError:true}})}]},
  {structuredContent:{ok:true,result:{error:'business value'}}}];
 values.forEach((value,i)=>{metrics=sandbox.addVibeJournalMetrics(metrics,[intent('t'+i),at(1792000000000+i*1000),result('t'+i,'tool_succeeded',value),at(1792000000500+i*1000)].join('\n'));});
 const view=sandbox.vibeMetricsView(metrics,0);assert.equal(view.toolCalls,5);assert.equal(view.toolFailures,4);assert.equal(view.tools[0].failures,4);
});
test('ACP completed updates carrying MCP errors preserve the code and become failed events',()=>{
 const events=[];sandbox.pushEvent=(_entry,type,data)=>events.push({type,data});sandbox.now=()=>1000;
 const entry={provider:'vibe',toolCallTitles:{},toolStartedAt:{call:100},sessionId:'s'};
 sandbox.normalizeSessionUpdate(entry,{sessionId:'s',update:{sessionUpdate:'tool_call_update',toolCallId:'call',status:'completed',rawOutput:{structuredContent:{error:{code:'INVALID_TARGET',message:'Unknown target',hint:'Read the palette'}}}}});
 const event=events.find(e=>e.type==='tool/update');assert.equal(event.data.status,'failed');assert.equal(event.data.failure.code,'INVALID_TARGET');assert.equal(event.data.failure.message,'Unknown target');
});
test('per-request metrics retain observed boundaries and token details across journal reads, without invented first-token or latency data',()=>{
 let metrics=sandbox.addVibeJournalMetrics(sandbox.emptyVibeMetrics(),[intent('model','completion'),at(1792000000000)].join('\n'),'ml4');
 assert.equal(metrics.modelRequests[0].status,'running');assert.equal(metrics.modelRequests[0].startedAt,1792000000000);
 metrics=sandbox.addVibeJournalMetrics(JSON.parse(JSON.stringify(metrics)),[
  result('model','completion_succeeded',{finish_reason:'tool_call',usage:{input_tokens:100,cached_input_tokens:90,output_tokens:20,reasoning_tokens:12}}),at(1792000337000)
 ].join('\n'),'ml4');
 const row=sandbox.vibeMetricsView(metrics,0).modelRequests[0];
 assert.equal(row.durationMs,337000);assert.equal(row.model,'ml4');assert.equal(row.inputTokens,100);assert.equal(row.cachedTokens,90);assert.equal(row.outputTokens,20);assert.equal(row.reasoningTokens,12);
 assert.equal(row.firstTokenAt,null);assert.equal(row.providerLatencyMs,null);assert.equal(row.timeToFirstTokenMs,null);assert.equal(row.timingSource,'journal_boundary');
 assert.doesNotMatch(JSON.stringify(row),/prompt|command|content/);
});
test('explicit provider timings and reasoning usage are retained, with bounded request history',()=>{
 const metrics=sandbox.emptyVibeMetrics();sandbox.addVibeJournalMetrics(metrics,[intent('model','completion'),at(1792000000000),
  result('model','completion_succeeded',{usage:{prompt_tokens:100,prompt_tokens_details:{cached_tokens:80},completion_tokens:10,completion_tokens_details:{reasoning_tokens:3}},
   timings:{first_token_at_ms:1792000000200,provider_latency_ms:180}}),at(1792000001000)].join('\n'));
 const row=metrics.modelRequests[0];assert.equal(row.timeToFirstTokenMs,200);assert.equal(row.providerLatencyMs,180);assert.equal(row.reasoningTokens,3);
 for(let i=0;i<1001;i++)sandbox.vibeModelRequest(metrics,'r'+i,'turn','model');
 assert.equal(metrics.modelRequests.length,1000);assert.equal(metrics.omittedModelRequests,2);
});
