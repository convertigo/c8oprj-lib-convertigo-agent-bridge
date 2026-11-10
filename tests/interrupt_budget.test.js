const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../js/agent_bridge_common.js'), 'utf8');
function fixture(defer = false) {
  let clock = 0, alive = true;
  const tasks = [], writes = [], calls = [];
  const entry = {handle:'fixture',protocol:'acp',process:{},turnActive:true,turnRequestId:'original',sessionId:'session',codexThreadId:'thread',activeTurnId:'turn',nextRequestId:1,pid:1,
    writer:{close(){assert.equal(alive,false,'writer lock must not precede process termination');calls.push('close');}}};
  function Thread(runnable) { this.run=runnable.run;this.setDaemon=()=>{};this.start=()=>{if(defer)tasks.push(this.run);else this.run();}; }
  Thread.sleep = n => { clock += n; };
  function AtomicReference(){let value=null;this.get=()=>value;this.set=v=>{value=v;};}
  const s={entry,C8O:{agentBridge:{}},Thread,Runnable:function(r){return r;},Packages:{java:{util:{concurrent:{atomic:{AtomicReference}}}}},UUID:{randomUUID:()=> 'fixture'},
    trim:v=>String(v==null?'':v).trim(),now:()=>clock,intValue:(v,d,min,max)=>Math.max(min,Math.min(max,v==null?d:v)),resolveHandle:v=>v,
    getRegistry:()=>({get:()=>entry,remove(){}}),processAlive:()=>alive,statusOf:()=>({alive}),writeJson:(_e,m)=>writes.push(m),
    pushEvent:(e,t)=>{if(t==='system/closed')e.turnActive=false;},entryUsesPidTree:()=>true,destroyPidTree:()=>{alive=false;calls.push('kill');return true;},
    deleteEntryPidFile(){},getExitCode:()=>0,forgetSessionHandle(){}};
  vm.createContext(s);
  vm.runInContext(source.slice(source.indexOf('  var TURN_INTERRUPT_ADAPTERS ='),source.indexOf('  // A request of the Convertigo MCP waiting')),s);
  vm.runInContext(source.slice(source.indexOf('  function stopEntry('),source.indexOf('  // The sweep of the agent processes')),s);
  return {s,entry,tasks,writes,calls,clock:()=>clock};
}
for (const protocol of ['claude-stream-json','acp','codex-app-server']) {
  test(protocol+': a stalled signal delivery cannot consume an unbounded wait',()=>{
    const f=fixture(true);f.entry.protocol=protocol;
    const r=f.s.C8O.agentBridge.interrupt({handle:'fixture',waitMs:150});
    assert.equal(r.status,'timeout');assert.ok(f.clock()<=250);assert.equal(f.tasks.length,1);
    f.s.stopEntry(f.entry,false);assert.deepEqual(f.calls,['kill','close']);
  });
}
test('the delayed interrupt is not sent into the next turn',()=>{
  const f=fixture(true);f.s.C8O.agentBridge.interrupt({handle:'fixture',waitMs:0});
  f.entry.turnRequestId='next';f.tasks[0]();assert.equal(f.writes.length,0);
});
test('a responsive provider keeps the existing cancel protocol',()=>{
  const f=fixture();f.s.C8O.agentBridge.interrupt({handle:'fixture',waitMs:0});
  assert.equal(f.writes[0].method,'session/cancel');assert.equal(f.writes[0].id,undefined);
});
test('the explicit close fallback sends no second blocking protocol request',()=>{
  const source=fs.readFileSync(require('node:path').join(__dirname,'../js/agent_bridge_vibe.js'),'utf8');
  const s={C8O:{agentBridge:{}},resolveHandle:v=>v,getRegistry:()=>({get:()=>({})}),forgetSessionHandle(){},statusOf:()=>({}),stopEntry:()=>{s.closed=true;},now:()=>0,acpRequest:()=>{throw new Error('close must not write to the stalled pipe');}};
  vm.createContext(s);vm.runInContext(source.slice(source.indexOf('  C8O.agentBridge.vibeClose ='),source.indexOf('  // Browser login')),s);
  assert.equal(s.C8O.agentBridge.vibeClose({handle:'fixture'}).ok,true);assert.equal(s.closed,true);
});
