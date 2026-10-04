import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import {projectSnapshot,makePatch,applyPatch,snapshotDigest} from '../site/sync-protocol.mjs';
import {createWorker} from '../site/cloud-worker.mjs';
import {RemoteSync} from '../scripts/remote-sync.mjs';

const key='a'.repeat(64);
function snapshot(time=new Date().toISOString()){return {generatedAt:time,revision:1,source:{kind:'local',storage:'sqlite',pollMs:2000},totals:{tasks:1,events:1},tasks:[{id:'root',title:'監視中',status:'running',parentId:null,updatedAt:time}],events:[{id:'event',taskId:'root',name:'functions.exec',type:'tool',time,status:'running',evidence:'log'}]};}
function database(){const db=new DatabaseSync(':memory:');db.exec(fs.readFileSync(new URL('../site/drizzle/0000_great_giant_girl.sql',import.meta.url),'utf8'));return {db,prepare(sql){const stmt=db.prepare(sql);return {bind(...values){return {async first(){return stmt.get(...values)||null;},async run(){return stmt.run(...values);}};}};}};}
function request(path,{method='GET',body,service=false,user=false}={}){const headers={};if(service)headers['X-Trace-Key']=key;if(user)headers['oai-authenticated-user-id']='authorized-site-user';if(body)headers['Content-Type']='application/json';return new Request('https://test.chatgpt.site'+path,{method,headers,body:body?JSON.stringify(body):undefined});}

test('remote projection excludes prompts, arguments, output, paths and credentials',()=>{
 const input=snapshot();input.credentials='SECRET';input.tasks[0].prompt='SECRET';input.tasks[0].file='C:/private/file';input.events[0].arguments='SECRET';input.events[0].output='SECRET';input.source.auth='SECRET';const data=projectSnapshot(input);assert.equal(JSON.stringify(data).includes('SECRET'),false);assert.equal(JSON.stringify(data).includes('C:/private'),false);
 assert.throws(()=>projectSnapshot({...input,source:{kind:'demo'}}));
});
test('delta transfer preserves updates and removals without sending the full dataset',()=>{
 const old=projectSnapshot(snapshot()),next=projectSnapshot(snapshot());next.events[0].status='completed';next.events.push({...next.events[0],id:'new'});const patch=makePatch(old,next,'digest');assert.equal(patch.mode,'delta');assert.deepEqual(applyPatch(old,patch),next);
 const removed=projectSnapshot({...next,events:[]});assert.deepEqual(applyPatch(next,makePatch(next,removed,'digest')),removed);
});
test('unauthenticated access and ingestion are rejected before database reads',async()=>{
 const worker=createWorker();assert.equal((await worker.fetch(request('/api/snapshot'),{})).status,401);assert.equal((await worker.fetch(request('/api/sync',{method:'POST',body:{}}),{})).status,401);
});
test('signed private service uploads persist and remote viewers read data without localhost',async()=>{
 const DB=database(),worker=createWorker(),env={DB,TRACE_SYNC_KEY:key};
 try{const data=projectSnapshot(snapshot());const ack=await (await worker.fetch(request('/api/sync',{method:'POST',service:true,body:makePatch(null,data,null)}),env)).json();assert.equal(ack.accepted,true);assert.equal(ack.digest,await snapshotDigest(data));
 const response=await worker.fetch(request('/api/snapshot',{user:true}),env);const result=await response.json();assert.equal(response.status,200);assert.equal(result.tasks[0].title,'監視中');assert.equal(result.source.kind,'cloud');assert.equal(response.headers.get('Cache-Control'),'private, no-store');assert.equal(result.remote.stale,false);
 const delta=await worker.fetch(request('/api/sync',{method:'POST',service:true,body:{mode:'delta',baseDigest:'wrong'}}),env);assert.equal(delta.status,409);
 }finally{DB.db.close();}
});
test('collection failure is stale even when upload heartbeats still arrive',async()=>{
 const DB=database(),worker=createWorker(),env={DB,TRACE_SYNC_KEY:key};try{const data=snapshot(new Date(Date.now()-180000).toISOString());await worker.fetch(request('/api/sync',{method:'POST',service:true,body:{mode:'full',snapshot:data}}),env);const remote=await (await worker.fetch(request('/api/snapshot',{service:true}),env)).json();assert.ok(remote.remote.ageMs<5000);assert.equal(remote.remote.collectorStale,true);assert.equal(remote.remote.stale,true);}finally{DB.db.close();}
});
test('out of order snapshots cannot overwrite a newer state',async()=>{
 const DB=database(),worker=createWorker(),env={DB,TRACE_SYNC_KEY:key};try{await worker.fetch(request('/api/sync',{method:'POST',service:true,body:{mode:'full',snapshot:snapshot()}}),env);const result=await worker.fetch(request('/api/sync',{method:'POST',service:true,body:{mode:'full',snapshot:snapshot(new Date(Date.now()-10000).toISOString())}}),env);assert.equal(result.status,409);}finally{DB.db.close();}
});
test('uploader retries base conflicts once, uses HTTPS only and never overlaps requests',async()=>{
 let calls=0;const bodies=[];const sync=new RemoteSync({origin:'https://test.chatgpt.site',apiToken:'fixture-token',syncKey:key,getSnapshot:snapshot,fetchImpl:async(url,options)=>{assert.equal(url.origin,'https://test.chatgpt.site');assert.equal(options.redirect,'error');assert.equal(options.headers['X-Trace-Key'],key);bodies.push(JSON.parse(options.body));calls++;return calls===1?new Response('{}',{status:409}):Response.json({accepted:true,digest:'new-digest',receivedAt:new Date().toISOString()});}});
 await Promise.all([sync.tick(),sync.tick()]);assert.equal(calls,2);assert.equal(sync.status().connected,true);assert.ok(bodies.every(b=>b.mode==='full'));assert.equal(JSON.stringify(sync.status()).includes('fixture-token'),false);
});
