import {MAX_SYNC_BYTES,projectSnapshot,applyPatch,snapshotDigest} from './sync-protocol.mjs';

const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
function serviceAccess(request,env){const supplied=request.headers.get('X-Trace-Key')||'',expected=env.TRACE_SYNC_KEY||'';if(expected.length!==64||supplied.length!==64)return false;let difference=0;for(let i=0;i<64;i++)difference|=supplied.charCodeAt(i)^expected.charCodeAt(i);return difference===0;}
function dataAccess(request,env){return Boolean(request.headers.get('oai-authenticated-user-id'))||serviceAccess(request,env);}
async function stateRow(env){if(!env.DB)throw new Error('database_unavailable');return env.DB.prepare('SELECT payload,digest,generated_at,received_at FROM remote_state WHERE slot = ?').bind('primary').first();}
function recentHistory(snapshot,url){
 const taskId=url.searchParams.get('taskId');const ids=new Set(taskId?[taskId]:snapshot.tasks.map(t=>t.id));let changed=true;
 while(taskId&&changed){changed=false;for(const task of snapshot.tasks)if(ids.has(task.parentId)&&!ids.has(task.id)){ids.add(task.id);changed=true;}}
 const before=url.searchParams.get('before'),beforeId=url.searchParams.get('beforeId')||'';const limit=Math.max(1,Math.min(200,Number(url.searchParams.get('limit'))||100));
 const rows=snapshot.events.filter(e=>ids.has(e.taskId)&&(!before||e.time<before||e.time===before&&e.id<beforeId)).sort((a,b)=>b.time.localeCompare(a.time)||b.id.localeCompare(a.id));
 const events=rows.slice(0,limit),last=events.at(-1);return {events,hasMore:rows.length>limit,cursor:rows.length>limit?{time:last.time,id:last.id}:null,coverage:'remote_recent_window'};
}
export function createWorker(assets={}){return {async fetch(request,env){
 const url=new URL(request.url),path=url.pathname;
 try{
  if(path==='/api/sync'){
   if(request.method!=='POST')return json({error:'method_not_allowed'},405);
   if(!serviceAccess(request,env))return json({error:'unauthorized'},401);
   if(!request.headers.get('content-type')?.startsWith('application/json'))return json({error:'invalid_content_type'},415);
   const declared=Number(request.headers.get('content-length')||0);if(declared>MAX_SYNC_BYTES)return json({error:'payload_too_large'},413);
   const bytes=await request.arrayBuffer();if(bytes.byteLength>MAX_SYNC_BYTES)return json({error:'payload_too_large'},413);
   let patch;try{patch=JSON.parse(new TextDecoder().decode(bytes));}catch{return json({error:'invalid_json'},400);}
   const current=await stateRow(env);if(patch.mode==='delta'&&(!current||patch.baseDigest!==current.digest))return json({error:'full_required'},409);
   let snapshot;try{snapshot=applyPatch(current?JSON.parse(current.payload):null,patch);}catch{return json({error:'invalid_snapshot'},400);}
   if(Date.parse(snapshot.generatedAt)>Date.now()+300000)return json({error:'invalid_timestamp'},400);
   if(current&&snapshot.generatedAt<current.generated_at)return json({error:'stale_snapshot'},409);
   const payload=JSON.stringify(snapshot);if(new TextEncoder().encode(payload).byteLength>MAX_SYNC_BYTES)return json({error:'payload_too_large'},413);
   const digest=await snapshotDigest(snapshot),receivedAt=new Date().toISOString();
   if(!current){await env.DB.prepare('INSERT INTO remote_state (slot,payload,digest,generated_at,received_at) VALUES (?,?,?,?,?) ON CONFLICT(slot) DO NOTHING').bind('primary',payload,digest,snapshot.generatedAt,receivedAt).run();}
   else{await env.DB.prepare('UPDATE remote_state SET payload=?,digest=?,generated_at=?,received_at=? WHERE slot=? AND digest=?').bind(payload,digest,snapshot.generatedAt,receivedAt,'primary',current.digest).run();}
   const stored=await stateRow(env);if(stored.digest!==digest)return json({error:'full_required'},409);
   return json({accepted:true,digest,generatedAt:snapshot.generatedAt,receivedAt,taskCount:snapshot.tasks.length,eventCount:snapshot.events.length});
  }
  if(path.startsWith('/api/')){
   if(request.method!=='GET')return json({error:'method_not_allowed'},405);
   if(!dataAccess(request,env))return json({error:'unauthorized'},401);
   const row=await stateRow(env);if(!row)return json({error:'awaiting_sync'},503);
   const snapshot=projectSnapshot(JSON.parse(row.payload));const ageMs=Math.max(0,Date.now()-Date.parse(row.received_at)),collectorAgeMs=Math.max(0,Date.now()-Date.parse(row.generated_at));
   if(path==='/api/snapshot')return json({...snapshot,tasks:[...snapshot.tasks].sort((a,b)=>(b.updatedAt||'').localeCompare(a.updatedAt||'')),events:[...snapshot.events].sort((a,b)=>a.time.localeCompare(b.time)||a.id.localeCompare(b.id)),source:{...snapshot.source,kind:'cloud',label:'ローカルPCからの同期データ',transport:'https'},remote:{receivedAt:row.received_at,ageMs,collectorAgeMs,collectorStale:collectorAgeMs>30000,stale:ageMs>30000||collectorAgeMs>30000,digest:row.digest}});
   if(path==='/api/history')return json(recentHistory(snapshot,url));
   if(path==='/api/health')return json({service:'codex-trace-cloud',receivedAt:row.received_at,generatedAt:row.generated_at,ageMs,collectorAgeMs,stale:ageMs>30000||collectorAgeMs>30000,digest:row.digest,taskCount:snapshot.tasks.length,eventCount:snapshot.events.length});
   return json({error:'not_found'},404);
  }
  if(request.method!=='GET'&&request.method!=='HEAD')return new Response('Read only',{status:405});
  const key=path==='/'?'index.html':path.slice(1);const asset=assets[key];if(!asset)return new Response('Not found',{status:404});
  return new Response(request.method==='HEAD'?null:asset.body,{headers:{'Content-Type':asset.type,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
 }catch{return json({error:'remote_unavailable'},503);}
}};}
export default createWorker(typeof TRACE_STATIC_ASSETS==='undefined'?{}:TRACE_STATIC_ASSETS);
