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
recordVibeUsage(vibe,{used:null,size:null});assert.equal(vibe.quota.context.usedTokens,null);
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
