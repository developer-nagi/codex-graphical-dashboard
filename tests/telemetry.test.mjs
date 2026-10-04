import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {TelemetryCollector} from '../scripts/collector.mjs';
import {TelemetryStore} from '../scripts/store.mjs';

const stamp='2026-10-04T05:00:00.000Z';
const row=(type,payload,ordinal=20)=>({timestamp:stamp,type,payload,ordinal});
const meta=(id='root',parent=null)=>row('session_meta',{id,session_id:parent||id,parent_thread_id:parent,subagent_history_start_ordinal:parent?13:0},0);
const call=(id,name='exec')=>row('response_item',{type:'custom_tool_call',name,call_id:id,input:'const hidden="PROMPT_SECRET"; await tools.exec_command({cmd:"SECRET_ARGS"});'});
const output=(id,text='Script completed')=>row('response_item',{type:'custom_tool_call_output',call_id:id,output:text});
const titleMeta=(id='task-title',time=stamp)=>({...meta(id),timestamp:time});
const titleComplete=(time=stamp)=>row('event_msg',{type:'task_complete'},21);
const writeIndex=async(dir,lines)=>fs.writeFile(path.join(dir,'session_index.jsonl'),lines.map(line=>typeof line==='string'?line:JSON.stringify(line)).join('\n')+'\n');
const writeThreads=async(dir,file,definition,rows)=>{const db=new DatabaseSync(path.join(dir,file));try{db.exec(definition);const insert=db.prepare('INSERT INTO threads VALUES(?,?)');for(const [id,name] of rows)insert.run(id,name);}finally{db.close();}};

test('subagent keeps its own identity and ignores inherited records',()=>{
 const c=new TelemetryCollector();c.consume(meta('child','root'),'child');c.consume(meta('root'),'child');c.consume(call('old'), 'child');c.consume(row('response_item',{type:'function_call',namespace:'clock',name:'sleep',call_id:'inherited'},5),'child');
 assert.equal(c.tasks.get('child').id,'child');assert.equal(c.tasks.get('child').parentId,'root');assert.equal([...c.events.values()].filter(e=>e.evidence==='log').length,1);assert.equal([...c.events.values()][0].taskId,'child');
});
test('raw prompts, tool arguments, reasoning and results never reach storage or snapshot',()=>{
 const store=new TelemetryStore(':memory:');const c=new TelemetryCollector({store});c.consume(meta(),'file');c.consume(row('response_item',{type:'reasoning',content:'REASONING_SECRET'}),'file');c.consume(call('a'),'file');c.consume(output('a','RESULT_SECRET'),'file');store.save(c.tasks,c.events.values(),new Map());
 const serialized=JSON.stringify(c.snapshot());const rows=store.db.prepare('SELECT data FROM events').all();for(const secret of ['PROMPT_SECRET','SECRET_ARGS','RESULT_SECRET','REASONING_SECRET'])assert.equal(serialized.includes(secret)||JSON.stringify(rows).includes(secret),false);store.close();
});
test('yielded exec is completed by matching wait, without claiming nested process completion',()=>{
 const c=new TelemetryCollector();c.consume(meta(),'file');c.consume(call('a'),'file');c.consume(output('a','Script running with cell ID 8'),'file');assert.equal([...c.events.values()].find(e=>e.callId==='a').status,'running');
 c.consume(row('response_item',{type:'function_call',name:'wait',namespace:'functions',call_id:'w',arguments:'{"cell_id":"8"}'}),'file');c.consume(output('w'),'file');assert.equal([...c.events.values()].find(e=>e.callId==='a').status,'completed');
 c.consume(call('nested'),'file');c.consume(output('nested','Script completed {"session_id":123}'),'file');assert.equal([...c.events.values()].find(e=>e.callId==='nested').status,'completed');
});
test('SQLite deduplicates calls, survives restart and completes a call outside the display cache',()=>{
 const store=new TelemetryStore(':memory:');const c=new TelemetryCollector({store});c.consume(meta(),'file');c.consume(call('long'),'file');store.save(c.tasks,c.events.values(),new Map());const original=[...c.events.values()].find(e=>e.callId==='long');
 for(let i=0;i<6100;i++)store.putEvent.run('f'+i,'root',stamp,'tool','completed','log',JSON.stringify({id:'f'+i,taskId:'root',time:stamp,type:'tool',status:'completed',evidence:'log',name:'test'}));
 const restarted=new TelemetryCollector({store});assert.equal(restarted.events.has(original.id),false);restarted.consume(output('long'),'file');store.save(restarted.tasks,[...restarted.dirtyEvents].map(id=>restarted.events.get(id)),new Map());assert.equal(store.findCall('root','long').status,'completed');const count=store.totals().events;restarted.consume(call('long'),'file');restarted.consume(output('long'),'file');store.save(restarted.tasks,restarted.events.values(),new Map());assert.equal(store.totals().events,count);store.close();
});
test('large logs ingest their middle and resume partial UTF-8 lines across restart',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codex-trace-test-'));const file=path.join(dir,'large.jsonl');const store=new TelemetryStore(path.join(dir,'telemetry.db'));const c=new TelemetryCollector({store});
 try{const filler=JSON.stringify(row('response_item',{type:'message',content:'PRIVATE_FILLER'.repeat(2500)}))+'\n';const body=JSON.stringify(meta())+'\n'+filler.repeat(130)+JSON.stringify(call('middle'))+'\n'+filler.repeat(130)+JSON.stringify(output('middle'))+'\n';await fs.writeFile(file,body);const size=(await fs.stat(file)).size;assert.ok(size>8*1024*1024);
  let rounds=0;while((c.files.get(file)?.offset||0)<size){await c.readFile({file,size});rounds++;}assert.ok(rounds>=3);assert.equal([...c.events.values()].find(e=>e.callId==='middle').status,'completed');store.save(c.tasks,c.events.values(),c.files);
  const jp=Buffer.from(JSON.stringify(row('response_item',{type:'function_call',name:'日本語',namespace:'test',call_id:'utf8'}))+'\n');const index=jp.indexOf(Buffer.from('日'))+1;await fs.appendFile(file,jp.subarray(0,index));await c.readFile({file,size:(await fs.stat(file)).size});store.save(c.tasks,c.events.values(),c.files);await fs.appendFile(file,jp.subarray(index));const restarted=new TelemetryCollector({store});await restarted.readFile({file,size:(await fs.stat(file)).size});assert.equal([...restarted.events.values()].find(e=>e.callId==='utf8').name,'test.日本語');
 }finally{store.close();const target=path.resolve(dir);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert.ok(path.basename(target).startsWith('codex-trace-test-'));await fs.rm(target,{recursive:true,force:true});}
});
test('history pagination uses stable time/id ordering and includes descendants',()=>{
 const store=new TelemetryStore(':memory:');store.save(new Map([['r',{id:'root',parentId:null,updatedAt:stamp}],['c',{id:'child',parentId:'root',updatedAt:stamp}]]),Array.from({length:501},(_,i)=>({id:String(i).padStart(4,'0'),taskId:i%2?'child':'root',time:stamp,name:'tool',type:'tool',status:'completed',evidence:'log'})),new Map());let page=store.history({taskId:'root',limit:200}),ids=page.events.map(e=>e.id);while(page.hasMore){page=store.history({taskId:'root',limit:200,before:page.cursor.time,beforeId:page.cursor.id});ids.push(...page.events.map(e=>e.id));}assert.equal(ids.length,501);assert.equal(new Set(ids).size,501);store.close();
});
test('MCP completion records runtime plugin identity while script detection stays unconfirmed',()=>{
 const c=new TelemetryCollector();c.consume(meta(),'file');c.consume(call('a'),'file');c.consume(row('event_msg',{type:'item_completed',item:{type:'McpToolCall',id:'mcp',server:'codex_apps',tool:'sites.create_site',status:'Completed',duration:34,arguments:'SECRET',result:'SECRET'}}),'file');const e=[...c.events.values()].find(x=>x.callId==='mcp');assert.equal(e.plugin,'Sites');assert.equal(e.status,'completed');assert.equal(e.evidence,'log');assert.equal([...c.events.values()].find(x=>x.name==='exec_command').evidence,'script');
});
test('yielding waits finish themselves and source linkage survives restart',()=>{
 const store=new TelemetryStore(':memory:');const c=new TelemetryCollector({store});c.consume(meta(),'file');c.consume(call('a'),'file');c.consume(output('a','Script running with cell ID 8'),'file');
 c.consume(row('response_item',{type:'function_call',name:'wait',namespace:'functions',call_id:'w1',arguments:'{"cell_id":"8"}'}),'file');c.consume(output('w1','Script running with cell ID 8'),'file');assert.equal([...c.events.values()].find(e=>e.callId==='w1').status,'completed');
 c.consume(row('response_item',{type:'function_call',name:'wait',namespace:'functions',call_id:'w2',arguments:'{"cell_id":"8"}'}),'file');store.save(c.tasks,c.events.values(),new Map(),c.cells);const resumed=new TelemetryCollector({store});resumed.consume(output('w2'),'file');assert.equal([...resumed.events.values()].find(e=>e.callId==='a').status,'completed');assert.equal([...resumed.events.values()].find(e=>e.callId==='w2').status,'completed');store.close();
});
test('more than 64 files rotate through ingestion and retain the display cache',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codex-trace-test-'));const sessionDir=path.join(dir,'sessions','2026','10','04');await fs.mkdir(sessionDir,{recursive:true});const store=new TelemetryStore(path.join(dir,'telemetry.db'));const c=new TelemetryCollector({codexHome:dir,store});
 try{for(let i=0;i<101;i++){const file=path.join(sessionDir,`rollout-${i}.jsonl`);await fs.writeFile(file,[meta('task-'+i),call('call-'+i),output('call-'+i)].map(x=>JSON.stringify(x)).join('\n')+'\n');}
  await c.scan();assert.equal(store.totals().tasks,64);await c.scan();assert.equal(store.totals().tasks,101);assert.equal(store.totals().events,101);await c.scan();assert.ok(c.snapshot().events.length>=101);
  const file=path.join(sessionDir,'rollout-0.jsonl');await fs.appendFile(file,JSON.stringify(call('resumed-101'))+'\n');const resumed=new TelemetryCollector({codexHome:dir,store});await resumed.scan();assert.ok(store.findCall('task-0','resumed-101'));assert.equal(store.totals().events,102);
 }finally{store.close();const target=path.resolve(dir);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert.ok(path.basename(target).startsWith('codex-trace-test-'));await fs.rm(target,{recursive:true,force:true});}
});

test('task titles prefer the latest state DB name and fall back to session index safely',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codex-trace-test-'));
 try{
  await fs.writeFile(path.join(dir,'.codex-global-state.json'),JSON.stringify({'thread-titles':{titles:{'task-db':'Global title','task-index':'Global fallback'}},'thread-descriptions':{'task-desc':{description:'Conversation description'}}}));
  await writeIndex(dir,[
   {id:'task-db',thread_name:'Index title',updated_at:'2026-10-04T04:00:00.000Z'},
   {id:'task-index',thread_name:'Older index title',updated_at:'2026-10-04T04:00:00.000Z'},
   '{broken json',
   {id:'task-index',thread_name:null,updated_at:'2026-10-04T06:00:00.000Z'},
   {id:'task-index',thread_name:'Latest index title',updated_at:'2026-10-04T05:00:00.000Z'},
   {id:'task-index',thread_name:'Partial newer line',updated_at:'not-a-date'}
  ]);
  await writeThreads(dir,'state_2.sqlite','CREATE TABLE threads(id TEXT PRIMARY KEY,name TEXT NOT NULL)',[
   ['task-db','Database title']
  ]);
  const beforeDb=await fs.readFile(path.join(dir,'state_2.sqlite'));
  const c=new TelemetryCollector({codexHome:dir});
  await c.readTitles();
  assert.equal(c.titles['task-db'],'Database title');
  assert.equal(c.titles['task-index'],'Latest index title');
  assert.equal(c.titles['task-desc'],undefined);
  assert.equal(c.titles['task-db'].includes('Global'),false);
  assert.equal(c.titles['task-index'].includes('Global'),false);
  assert.deepEqual(await fs.readFile(path.join(dir,'state_2.sqlite')),beforeDb);

  await writeIndex(dir,[
   {id:'task-db',thread_name:'Stale index title',updated_at:'2026-10-04T07:00:00.000Z'},
   {id:'task-index',thread_name:'Latest index title',updated_at:'2026-10-04T05:00:00.000Z'}
  ]);
  await fs.writeFile(path.join(dir,'state_2.sqlite'),'not a sqlite database');
  await c.readTitles();
  assert.equal(c.titles['task-db'],'Database title');

  await fs.rm(path.join(dir,'state_2.sqlite'),{force:true});
  const oldDb=new DatabaseSync(path.join(dir,'state_3.sqlite'));
  try{oldDb.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,first_user_message TEXT,globaldescription TEXT)');oldDb.prepare('INSERT INTO threads VALUES(?,?,?,?)').run('task-index','Conversation title','PROMPT_SECRET','DESCRIPTION_SECRET');}
  finally{oldDb.close();}
  const fallback=new TelemetryCollector({codexHome:dir});
  await fallback.readTitles();
  assert.equal(fallback.titles['task-index'],'Latest index title');
  assert.equal(fallback.titles['task-index'].includes('Conversation'),false);
 }finally{const target=path.resolve(dir);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert.ok(path.basename(target).startsWith('codex-trace-test-'));await fs.rm(target,{recursive:true,force:true});}
});

test('renamed task titles update SQLite across scans and restart without changing task state',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codex-trace-test-'));const logDir=path.join(dir,'sessions','2026','10','04');await fs.mkdir(logDir,{recursive:true});const file=path.join(logDir,'rollout-title.jsonl');const dbPath=path.join(dir,'telemetry.db');const store=new TelemetryStore(dbPath);
 try{
  await fs.writeFile(file,[titleMeta(),titleComplete()].map(x=>JSON.stringify(x)).join('\n')+'\n');
  await writeIndex(dir,[{id:'task-title',thread_name:'First task name',updated_at:'2026-10-04T05:00:00.000Z'}]);
  const first=new TelemetryCollector({codexHome:dir,store});await first.scan();
  const savedFirst=store.recentTasks().find(task=>task.id==='task-title');
  assert.equal(savedFirst.title,'First task name');assert.equal(savedFirst.status,'completed');assert.equal(savedFirst.updatedAt,stamp);
  await writeIndex(dir,[{id:'task-title',thread_name:'Renamed task',updated_at:'2026-10-04T06:00:00.000Z'}]);
  await first.scan();
  const savedSecond=store.recentTasks().find(task=>task.id==='task-title');
  assert.equal(savedSecond.title,'Renamed task');assert.equal(savedSecond.status,'completed');assert.equal(savedSecond.updatedAt,stamp);
  const restarted=new TelemetryCollector({codexHome:dir,store});
  assert.equal(restarted.tasks.get(file).title,'Renamed task');assert.equal(restarted.tasks.get(file).status,'completed');assert.equal(restarted.tasks.get(file).updatedAt,stamp);
 }finally{store.close();const target=path.resolve(dir);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert.ok(path.basename(target).startsWith('codex-trace-test-'));await fs.rm(target,{recursive:true,force:true});}
});
