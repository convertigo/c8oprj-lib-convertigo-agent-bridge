const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto'),path=require('node:path').win32;
const src=fs.readFileSync(require('node:path').join(__dirname,'../js/agent_bridge_common.js'),'utf8');
function segment(begin,end){return src.slice(src.indexOf('  function '+begin+'('),src.indexOf('  function '+end+'('));}
const scratchStart=src.indexOf('  function noCodeScratchDir(');
const scratch=src.slice(scratchStart,src.indexOf('  // The folders a confined',scratchStart));
const code=segment('stableId','hashShort')+segment('resolveVibeHome','resolveCodexHome')+scratch;
function fixture(windows){
 const ctx={isWindows:()=>windows,trim:v=>String(v||'').trim(),StandardCharsets:{UTF_8:'utf8'},
 UUID:{nameUUIDFromBytes(bytes){let h=crypto.createHash('md5').update(bytes).digest();h[6]=(h[6]&15)|48;h[8]=(h[8]&63)|128;let s=h.toString('hex');return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;}},
 java:{lang:{String:function(v){this.getBytes=()=>Buffer.from(String(v));}}},
 childPath:(a,b)=>path.join(a,b),normalizeScope:v=>v||'shared',resolveProjectIdOption:()=>'',isConvertigoGatewayProfile:o=>o.provider!=='vibe',
 contextUserId:()=> 'studio',userPathSlug:v=>v,resolveConversationIdOption:o=>o.conversationId};
 vm.runInNewContext(code,ctx);return ctx;
}
function decode(s){const alphabet='abcdefghijklmnopqrstuvwxyz234567';let bits=0,v=0,hex='';for(const c of s){v=(v<<5)|alphabet.indexOf(c);bits+=5;while(bits>=8){bits-=8;hex+=((v>>bits)&255).toString(16).padStart(2,'0');}v&=(1<<bits)-1;}return hex;}
test('compact names preserve all UUID bits and do not collapse UUIDs with the same first segment',()=>{
 const f=fixture(true),ids=['12345678-1234-5678-9012-123456789012','12345678-1234-5678-9012-123456789013','00000000-0000-0000-0000-000000000000','ffffffff-ffff-ffff-ffff-ffffffffffff'];
 const names=ids.map(id=>f.compactUuidDirectoryName(id));
 assert.equal(new Set(names.map(x=>x.toLowerCase())).size,ids.length);
 for(let i=0;i<ids.length;i++){assert.match(names[i],/^[a-z2-7]{26}$/);assert.equal(decode(names[i]),ids[i].replace(/-/g,''));}
 assert.throws(()=>f.compactUuidDirectoryName('first-segment'),/Invalid/);
});
test('Windows conversation paths shrink while logical IDs, user isolation and other scopes stay stable',()=>{
 const old=fixture(false),win=fixture(true),conversationId='conversation-11111111-2222-3333-8444-555555555555';
 const options={conversationId,userId:'studio',homeScope:'conversation'};
 const legacy=old.resolveVibeHome(options,'C:\\Tigo\\vibe'),compact=win.resolveVibeHome(options,'C:\\Tigo\\vibe');
 assert.equal(compact.conversationId,conversationId);assert.equal(compact.userId,'studio');
 assert.ok(legacy.path.length-compact.path.length>=60);
 const suffix='logs\\session\\unified\\aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\\chunks\\aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json.0123456789abcdef.tmp';
 assert.equal(path.join(legacy.path,suffix).length,273);assert.ok(path.join(compact.path,suffix).length<=200);
 assert.ok(path.join(win.resolveVibeHome(options,'C:\\Tigo\\agents\\vibe').path,suffix).length<260);
 assert.notEqual(compact.path,win.resolveVibeHome({...options,userId:'other'},'C:\\Tigo\\vibe').path);
 assert.equal(win.resolveVibeHome({...options,homeScope:'user'},'C:\\Tigo\\vibe').path,old.resolveVibeHome({...options,homeScope:'user'},'C:\\Tigo\\vibe').path);
 assert.equal(win.stableId('project','same'),old.stableId('project','same'));
 assert.match(path.basename(compact.path),/^[a-z2-7]{26}$/);
 const other=win.resolveVibeHome({...options,userId:'other'},'C:\\Tigo\\vibe');
 assert.notEqual(compact.path,win.resolveVibeHome({...options,provider:'vibe'},'C:\\Tigo\\vibe').path);
 assert.equal(win.noCodeScratchDir(options,compact.path),path.join(compact.path,'s',win.stableId('conversation',conversationId)));
 assert.notEqual(win.noCodeScratchDir(options,compact.path),win.noCodeScratchDir(options,other.path));
 assert.notEqual(win.noCodeScratchDir(options,compact.path),win.noCodeScratchDir({...options,conversationId:'another'},compact.path));
 assert.notEqual(compact.path,win.resolveVibeHome({...options,conversationId:conversationId+'other'},'C:\\Tigo\\vibe').path);
 assert.equal(compact.path,win.resolveVibeHome(options,'C:\\Tigo\\vibe').path);
});
