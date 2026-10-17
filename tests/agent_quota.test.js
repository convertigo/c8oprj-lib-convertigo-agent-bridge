const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const javaProxy = new Proxy(function(){},{get(_t,p){if(p===Symbol.toPrimitive)return ()=>'';return javaProxy;},apply(){return javaProxy;},construct(){return javaProxy;}});
global.Packages=javaProxy;global.context=javaProxy;global.C8O={agentBridge:{}};
for(const name of ['common','codex','claude'])vm.runInThisContext(fs.readFileSync('js/agent_bridge_'+name+'.js','utf8'));
const recorded=[];pushEvent=(_entry,type,data)=>recorded.push({type,data});now=()=>123456;
const codex={provider:'codex'};
recordCodexQuota(codex,{rateLimits:{primary:{usedPercent:25,windowDurationMins:300,resetsAt:200}}});
assert.equal(codex.quota.windows[0].remainingPercent,75);
recordCodexQuota(codex,{rateLimitsByLimitId:{a:{primary:{usedPercent:0}},b:{secondary:{usedPercent:100}}}});
assert.deepEqual(codex.quota.windows.map(w=>w.remainingPercent),[100,0]);
recordCodexQuota(codex,{rateLimits:{primary:{usedPercent:null}}});
assert.equal(codex.quota.windows[0].remainingPercent,null,'missing percentages are not zero usage');
const claude={provider:'claude'};
recordClaudeQuota(claude,{status:'allowed',rateLimitType:'five_hour',utilization:.6,resetsAt:200});
recordClaudeQuota(claude,{status:'allowed_warning',rate_limit_type:'seven_day',utilization:.9,resets_at:300});
assert.equal(claude.quota.windows.length,2);assert.equal(claude.quota.windows[0].remainingPercent,40);
recordClaudeQuota(claude,{status:'rejected',rateLimitType:'five_hour'});
assert.equal(claude.quota.windows.length,2);assert.equal(claude.quota.windows[0].remainingPercent,null);
const vibe={provider:'vibe'};
recordVibeUsage(vibe,{used:123,size:1000,cost:{amount:1.2,currency:'USD'}});
assert.equal(vibe.quota.available,false,'context consumption is not an account credit balance');
assert.equal(vibe.quota.context.usedTokens,123);assert.equal(vibe.quota.context.costAmount,1.2);
assert.equal(vibe.quota.context.limitKind,'compaction');
assert.equal(vibe.quota.context.costKind,'session_estimate','ACP token cost never establishes the account billing mode');
recordVibeUsage(vibe,{used:null,size:null});assert.equal(vibe.quota.context.usedTokens,null);
// Cached tokens come from the Vibe journal (completion_succeeded records), not from the usage update that reports 0.
const done=(input,cached,output)=>JSON.stringify({type:'action_result',payload:{result:{type:'completion_succeeded',result:{usage:{input_tokens:input,cached_input_tokens:cached,output_tokens:output}}}}});
const segment=addVibeJournalText(emptyVibeJournalSegment(),[done(1000,900,50),JSON.stringify({type:'action_result',payload:{result:{type:'tool_succeeded'}}}),'{"broken completion_succeeded',done(2000,1800,70)].join('\n'));
assert.equal(segment.requests,2);assert.equal(segment.inputTokens,3000);assert.equal(segment.cachedTokens,2700);assert.equal(segment.outputTokens,120);
const total=sumVibeJournalSegments({'a.jsonl':segment,'b.jsonl':addVibeJournalText(emptyVibeJournalSegment(),done(1000,0,10))});
assert.equal(total.requests,3);assert.equal(total.cachedTokens,2700);assert.equal(total.cacheRate,2700/4000);
assert.equal(sumVibeJournalSegments({}).cacheRate,null,'no request: the cache rate is unknown, not 0');
// Session cost from the journal: uncached input, cached input and output at each model's prices per million tokens.
const glm=addVibeJournalText(emptyVibeJournalSegment(),done(118900000,116700000,220000),'glm-5-3');
const priced=sumVibeJournalSegments({'a.jsonl':glm},{'glm-5-3':{inputPrice:1.4,cachedInputPrice:0.14,outputPrice:4.4}});
assert.equal(Math.round(priced.costAmount*100)/100,20.39);assert.equal(priced.costCurrency,'USD');
assert.equal(Math.round(priced.models['glm-5-3'].costAmount*100)/100,20.39);
const two=addVibeJournalText(addVibeJournalText(emptyVibeJournalSegment(),done(1000000,0,0),'glm-5-3'),done(1000000,0,0),'vision');
assert.equal(two.models.vision.requests,1,'a second model keeps its own bucket');
assert.equal(sumVibeJournalSegments({'a.jsonl':two},{'glm-5-3':{inputPrice:1.4,cachedInputPrice:0.14,outputPrice:4.4}}).costAmount,null,'a model without prices leaves the session cost unknown');
assert.equal(sumVibeJournalSegments({'a.jsonl':two},{'glm-5-3':{inputPrice:1.4,cachedInputPrice:0.14,outputPrice:4.4},vision:{inputPrice:2,cachedInputPrice:null,outputPrice:6}}).costAmount,3.4);
assert.equal(vibeJournalUsage('','abc'),null);assert.equal(vibeJournalUsage('/tmp','../x'),null,'the session id never leaves the journal directory');
// image-describe calls (a gateway vision model) come back in tool results with their own usage, summed per model.
const visionUsage=(callId,model,input,output,cost)=>({tool:'image-describe',callId,model,inputTokens:input,cachedTokens:0,outputTokens:output,reasoningTokens:output-10,totalTokens:input+output,cost,currency:cost===null?'':'USD'});
const toolDone=result=>JSON.stringify({type:'action_result',payload:{result:{type:'tool_succeeded',result}}});
const described=(usage)=>toolDone({content:[{type:'text',text:JSON.stringify({description:'ok',usage})}],structured_content:{description:'ok',usage}});
const seen={};
const visionSegment=addVibeJournalText(emptyVibeJournalSegment(),[
  done(1000,900,50),
  described(visionUsage('c1','mistral/mistral-large-4',1500,200,0.004)),
  // the same call echoed by run_typescript (wrapped, text only) is counted once
  toolDone({content:[{type:'text',text:JSON.stringify({result:{usage:visionUsage('c1','mistral/mistral-large-4',1500,200,0.004)}})}]}),
  // the hook record repeats the tool result: not an action_result, ignored
  JSON.stringify({type:'action_intent',payload:{request:{hook:'post_tool_call',input:{tool_result:{structured_content:{usage:visionUsage('c9','mistral/mistral-large-4',1,1,1)}}}}}}),
  described(visionUsage('c2','mistral/mistral-large-4',1000,100,0.002)),
  described(visionUsage('c3','other/vision',500,50,null)),
  toolDone({structured_content:{projects:[]}})
].join('\n'),'glm-5-3',seen);
assert.equal(visionSegment.requests,1,'tool results are not model requests of the agent');
assert.deepEqual(Object.keys(visionSegment.vision).sort(),['mistral/mistral-large-4','other/vision']);
assert.equal(visionSegment.vision['mistral/mistral-large-4'].calls,2);
assert.deepEqual(visionSegment.visionCallIds,['c1','c2','c3']);
// a call already counted in another segment is not counted again
const later=addVibeJournalText(emptyVibeJournalSegment(),described(visionUsage('c2','mistral/mistral-large-4',1000,100,0.002)),'glm-5-3',seen);
assert.equal(Object.keys(later.vision).length,0);
// One structure per model: the agent model priced from the journal, each vision model at the cost the gateway charged.
const glmPrices={'glm-5-3':{inputPrice:1.4,cachedInputPrice:0.14,outputPrice:4.4}};
const visionTotal=sumVibeJournalSegments({'a.jsonl':visionSegment,'b.jsonl':later},glmPrices);
assert.equal(visionTotal.requests,1,'the agent totals stay the agent model requests');
const large=visionTotal.models['mistral/mistral-large-4'];
assert.equal(large.kind,'vision');assert.equal(large.calls,2);assert.equal(large.requests,2);assert.equal(large.inputTokens,2500);assert.ok(Math.abs(large.costAmount-0.006)<1e-12);assert.equal(large.costSource,'gateway');
assert.equal(visionTotal.models['other/vision'].costAmount,null,'an unpriced vision call');
assert.equal(visionTotal.models['glm-5-3'].kind,'agent');assert.equal(visionTotal.models['glm-5-3'].costSource,'journal');
assert.equal(visionTotal.costAmount,null,'one unpriced model makes the session cost unknown');
assert.deepEqual(JSON.parse(JSON.stringify(visionTotal.sessionTokens)),{inputTokens:4000,cachedTokens:900,outputTokens:400},'session tokens: agent and vision models');
const pricedVision=sumVibeJournalSegments({'a.jsonl':addVibeJournalText(emptyVibeJournalSegment(),[done(1000000,0,0),described(visionUsage('c7','mistral/mistral-large-4',500,50,0.25))].join('\n'),'glm-5-3',{})},glmPrices);
assert.ok(Math.abs(pricedVision.costAmount-1.65)<1e-12,'the session cost adds the agent journal cost and the gateway cost');assert.equal(pricedVision.costCurrency,'USD');
assert.equal(Object.keys(sumVibeJournalSegments({'a.jsonl':segment}).models).length,1,'no vision call: only the agent model');
// browser-verify: one tool call, several model calls of the verification sub-agent, one usage block for all of them.
const verifyUsage=(callId,requests,input,output,cost)=>({tool:'browser-verify',callId,model:'mistral/mistral-large-4',requests,inputTokens:input,cachedTokens:100,outputTokens:output,reasoningTokens:0,totalTokens:input+output,cost,currency:cost===null?'':'USD',durationMs:18000});
const verified=usage=>toolDone({content:[{type:'text',text:JSON.stringify({verdict:'failed',checks:[],usage})}],structured_content:{verdict:'failed',checks:[],usage}});
const verifySeen={};
const verifySegment=addVibeJournalText(emptyVibeJournalSegment(),[
  done(1000,900,50),
  described(visionUsage('d1','mistral/mistral-large-4',1500,200,0.004)),
  verified(verifyUsage('verify-1',6,22000,900,0.0153)),
  verified(verifyUsage('verify-1',6,22000,900,0.0153)),
  verified(verifyUsage('verify-2',4,15000,600,0.01))
].join('\n'),'glm-5-3',verifySeen);
const verifyRow=verifySegment.vision['mistral/mistral-large-4'];
assert.equal(verifyRow.calls,11,'model calls: 1 description + 6 + 4 verification calls, the echoed verification once');
assert.equal(verifyRow.verifications,2);
assert.equal(verifyRow.inputTokens,38500);
assert.equal(verifyRow.costCalls,11);
const verifyTotal=sumVibeJournalSegments({'a.jsonl':verifySegment},glmPrices).models['mistral/mistral-large-4'];
assert.equal(verifyTotal.kind,'vision');assert.equal(verifyTotal.calls,11);assert.equal(verifyTotal.requests,11);assert.equal(verifyTotal.verifications,2);
assert.ok(Math.abs(verifyTotal.costAmount-0.0293)<1e-12);assert.equal(verifyTotal.costSource,'gateway');
const unpricedVerify=sumVibeJournalSegments({'a.jsonl':addVibeJournalText(emptyVibeJournalSegment(),[done(1000,0,0),verified(verifyUsage('verify-3',5,1000,10,null))].join('\n'),'glm-5-3',{})},glmPrices);
assert.equal(unpricedVerify.models['mistral/mistral-large-4'].costAmount,null,'an unpriced verification keeps the cost unknown');
assert.equal(unpricedVerify.costAmount,null);
// state files written before the vision totals still sum
assert.equal(sumVibeJournalSegments({'old.jsonl':{offset:9,requests:1,inputTokens:5,cachedTokens:0,outputTokens:1}}).requests,1);
recordVibeUsage(vibe,{used:5},{requests:3,inputTokens:4000,cachedTokens:2700,outputTokens:130,cacheRate:0.675});
assert.equal(vibe.quota.context.journal.cachedTokens,2700);
const pending={method:'account/rateLimits/read',done:false};
const entry={provider:'codex',lastError:'unchanged',pending:{get(){return pending;}}};
handleCodexAppServerLine(entry,JSON.stringify({id:7,error:{message:'unsupported'}}),'stdout');
assert.equal(pending.done,true);assert.equal(entry.lastError,'unchanged');
assert.ok(!recorded.some(e=>e.type==='turn/error'),'quota failure must not fail the conversation');
const notified={provider:'codex'};
handleCodexAppServerLine(notified,JSON.stringify({method:'account/rateLimits/updated',params:{rateLimits:{primary:{usedPercent:10}}}}),'stdout');
assert.equal(notified.quota.windows[0].remainingPercent,90);
processAlive=()=>false;getRegistry=()=>({get(){return vibe;}});resolveHandle=v=>v;
assert.equal(C8O.agentBridge.quota({handle:'existing'}).quota,vibe.quota);
assert.ok(!JSON.stringify(vibe.quota).includes('apiKey'));
console.log('Wrapper quota: Codex, Claude, ACP context, missing values and nonfatal errors passed');

assert.ok(!recorded.some(e=>e.type==='quota/update'),'quota snapshots must not enter the public event buffer');
const common=fs.readFileSync('js/agent_bridge_common.js','utf8');
const statusSource=common.slice(common.indexOf('  function statusOf(entry)'),common.indexOf('  C8O.agentBridge.events ='));
assert.ok(!/quota\s*:/.test(statusSource),'public runtime diagnostics must not expose quota snapshots');
console.log('Quota snapshots stay outside public diagnostics and event buffers');

// Modern Claude get_usage values are percentages, not event fractions. Keep
// model-scoped limits and convert the ISO reset to the common epoch contract.
const usageEntry={provider:'claude'};
recordClaudeUsage(usageEntry,{rate_limits_available:true,rate_limits:{
 five_hour:{utilization:24,resets_at:'2026-10-14T20:50:00Z'},
 seven_day:{utilization:64,resets_at:'2026-10-17T09:00:00Z'},
 model_scoped:[{display_name:'Fable',utilization:4,resets_at:'2026-10-17T09:00:00Z'}],
 credentials:'must not escape',extra_usage:{is_enabled:false}
}});
assert.deepEqual(usageEntry.quota.windows.map(w=>w.usedPercent),[24,64,4]);
assert.deepEqual(usageEntry.quota.windows.map(w=>w.windowDurationMins),[300,10080,10080]);
assert.equal(usageEntry.quota.windows[0].resetsAt,Date.parse('2026-10-14T20:50:00Z')/1000);
assert.ok(!JSON.stringify(usageEntry.quota).includes('credentials'));
recordClaudeUsage(usageEntry,{rate_limits_available:false,rate_limits:null});
assert.equal(usageEntry.quota.available,false);assert.deepEqual(usageEntry.quota.windows,[]);

// Account metadata replies (including account identity) never enter progress.
const metadataPending={method:'get_usage',done:false};
const metadataEntry={provider:'claude',pending:{get(){return metadataPending;}}};
handleClaudeStreamLine(metadataEntry,JSON.stringify({type:'control_response',response:{subtype:'success',request_id:'usage',response:{account:{token:'secret'},rate_limits_available:true,rate_limits:{seven_day:{utilization:64}}}}}),'stdout');
assert.equal(metadataPending.done,true);assert.equal(metadataEntry.quota.windows[0].usedPercent,64);
assert.ok(!JSON.stringify(recorded).includes('secret'));
console.log('Claude control usage: units, scoped models, missing limits and private replies passed');
