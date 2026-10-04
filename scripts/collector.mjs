import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

const safe = (s, max=180) => typeof s==='string' ? s.replace(/[\x00-\x1f]/g,' ').slice(0,max) : null;
const hash = s => createHash('sha256').update(s).digest('hex').slice(0,22);
const aliases = {sites:'Sites',chatgpt_space:'Pages',tavily:'Tavily',elevenlabs:'ElevenLabs',plugin_management:'Plugin Management',google_drive:'Google Drive',mcp__cua_repl:'Computer Use',mcp__codex_app:'Codex app tools'};
export function provenance(name){
  const m=name.match(/^mcp__([a-zA-Z0-9_]+?)(?:__|\.)(.+)$/);
  if(!m)return {server:null,plugin:null,provenance:'builtin'};
  const server=m[1], operation=m[2];
  const prefix=Object.keys(aliases).find(k=>operation.startsWith(k+'_')||operation.startsWith(k+'.'));
  return {server,plugin:aliases['mcp__'+server]||(server==='codex_apps'&&prefix?aliases[prefix]:null),provenance:'namespace'};
}
export class TelemetryCollector {
  constructor({codexHome=process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),days=2,maxFiles=64,store=null}={}){
    this.codexHome=codexHome;this.days=days;this.maxFiles=maxFiles;this.files=new Map();this.tasks=new Map();this.events=new Map();this.pending=new Map();this.revision=0;this.errors=0;this.updatedAt=null;this.titles={};this.scanCount=0;
    this.store=store;this.dirtyEvents=new Set();this.cells=new Map();this.waitTargets=new Map();this.inflight=new Map();this.oversizeRecords=0;this.lastServed=new Map();
    if(store){const saved=store.restore();this.files=new Map(saved.cursors);this.tasks=new Map(saved.tasks);this.cells=new Map(saved.links);for(const e of saved.events){this.events.set(e.id,e);if(e.status==='running'&&e.callId){this.pending.set(e.taskId+':'+e.callId,e.id);this.inflight.set(e.id,e);}}}
  }
  record(event){this.events.set(event.id,event);this.dirtyEvents.add(event.id);if(event.status==='running'&&event.callId)this.inflight.set(event.id,event);else this.inflight.delete(event.id);}
  consume(line,file){
    let r;try{r=typeof line==='string'?JSON.parse(line):line;}catch{return;}
    const p=r.payload||{};let task=this.tasks.get(file);
    const stamp=Number.isFinite(Date.parse(r.timestamp))?r.timestamp:new Date().toISOString();
    if(r.type==='session_meta'){
      if(task)return; // A subagent may contain an inherited parent session_meta.
      const id=safe(p.id||p.session_id,100);if(!id)return;
      const sub=p.source?.subagent||p.source?.sub_agent||p.thread_source?.subagent;
      const parent=safe(p.parent_thread_id||sub?.thread_spawn?.parent_thread_id||p.source?.parent_thread_id,100);
      const fallback=safe(p.agent_path?.split('/').at(-1)||p.agent_nickname||p.agent_role)||`タスク ${id.slice(0,8)}`;
      task={id,title:this.titles[id]||fallback,parentId:parent||null,forkedFromId:safe(p.forked_from_id,100),historyStart:p.subagent_history_start_ordinal||0,status:'unknown',model:safe(p.agent_role)||'Codex',updatedAt:stamp,lastEventAt:stamp,source:'local-log'};
      this.tasks.set(file,task);this.revision++;return;
    }
    if(!task)return;
    if(Number.isFinite(r.ordinal)&&r.ordinal<task.historyStart)return;
    if(Date.parse(stamp)>Date.parse(task.updatedAt))task.updatedAt=stamp;
    if(r.type==='turn_context'){task.model=safe(p.model)||task.model;return;}
    if(r.type==='event_msg'){
      if(p.type==='item_completed'){
        const item=p.item||{};
        if(item.type==='SubAgentActivity'&&item.agent_thread_id){
          const name='collaboration.'+safe(item.kind||'activity',80),id=hash(task.id+':agent:'+String(item.id));
          this.record({id,taskId:task.id,targetTaskId:safe(item.agent_thread_id,100),name,plugin:null,server:null,provenance:'runtime',type:'agent',status:'completed',time:stamp,completedAt:stamp,durationMs:null,parentCallId:null,evidence:'log'});this.revision++;
        }
        if(item.type==='McpToolCall'||item.type==='CommandExecution'){
          const call=safe(item.id,120)||hash(task.id+stamp+item.type);
          const eventId=this.pending.get(task.id+':'+call);
          const prior=this.events.get(eventId)||this.inflight.get(eventId)||this.store?.findCall(task.id,call)||[...this.events.values()].find(e=>e.taskId===task.id&&e.callId===call);
          const name=item.type==='McpToolCall'?`mcp__${safe(item.server,100)}.${safe(item.tool,160)}`:'functions.exec_command';
          const duration=typeof item.duration==='number'?item.duration:item.duration?.secs!=null?Math.round(item.duration.secs*1000+(item.duration.nanos||0)/1000000):null;
          const event=prior||{id:hash(task.id+':item:'+call),callId:call,taskId:task.id,time:Number.isFinite(p.started_at_ms)?new Date(p.started_at_ms).toISOString():stamp,name,...provenance(name),type:'tool',parentCallId:null,evidence:'log'};
          const st=String(item.status||'').toLowerCase();event.status=st==='failed'||item.exit_code>0?'failed':st==='inprogress'||st==='running'?'running':'completed';event.durationMs=duration;event.completedAt=stamp;
          if(item.type==='McpToolCall'){event.server=safe(item.server,100);if(item.pluginId){const pluginId=safe(item.pluginId.split('@')[0],100);event.plugin=({'codex-app-tools':'Codex app tools','unified-computer-use':'Computer Use'})[pluginId]||pluginId;event.provenance='runtime-plugin';}event.name=name;}
          this.record(event);this.revision++;
          if(item.type==='CommandExecution'&&event.status==='completed'){
            const command=typeof item.command==='string'?item.command:Array.isArray(item.command)?item.command.join(' '):'';
            for(const match of command.matchAll(/[\\/]skills[\\/][^'"\r\n]*?SKILL\.md/gi)){
              const skillName=safe(match[0].replace(/\\/g,'/').split('/').at(-2),80);if(!skillName)continue;
              const id=hash(event.id+':skill:'+skillName);this.record({id,taskId:task.id,time:stamp,name:skillName,plugin:null,server:null,provenance:'skill-path',type:'skill',status:'completed',durationMs:null,parentCallId:event.id,evidence:'read'});
            }
          }
        }
      }
      if(p.type==='task_started'||p.type==='turn_started'){task.status='running';task.lastEventAt=stamp;}
      if(p.type==='task_complete'||p.type==='turn_complete'){task.status='completed';task.lastEventAt=stamp;}
      if(p.type==='turn_aborted'||p.type==='task_interrupted'){task.status='interrupted';task.lastEventAt=stamp;}
      if(p.type==='error'){task.status='failed';task.lastEventAt=stamp;}
      return;
    }
    if(r.type!=='response_item')return;
    if(p.type==='function_call'||p.type==='custom_tool_call'){
      const namespace=safe(p.namespace,100);const rawName=safe(p.name,200);if(!rawName)return;
      const name=namespace&&!rawName.startsWith(namespace+'.')?namespace+'.'+rawName:rawName==='exec'?'functions.exec':rawName;
      const call=safe(p.call_id||p.id,120)||hash(file+stamp+name+String(r.ordinal));
      const id=hash(task.id+call);const pr=provenance(name);
      const event={id,callId:call,taskId:task.id,time:stamp,name,...pr,type:name.startsWith('collaboration.')?'agent':'tool',status:'running',durationMs:null,parentCallId:null,evidence:'log'};
      this.record(event);this.pending.set(task.id+':'+call,id);task.lastEventAt=stamp;task.status='running';this.revision++;
      // Examine code/arguments transiently. Never publish or retain any raw code, prompt or result.
      const code=typeof p.input==='string'?p.input:typeof p.arguments==='string'?p.arguments:'';
      if(/(^|\.)(wait|write_stdin)$/.test(name)){try{const args=JSON.parse(code);const key=args.cell_id!=null?'cell:'+args.cell_id:args.session_id!=null?'session:'+args.session_id:null;const source=key&&this.cells.get(task.id+':'+key);if(source){this.waitTargets.set(id,source);event.sourceEventId=source;}}catch{}}
      if(name==='functions.exec'||name==='exec'){
        const names=[...new Set(Array.from(code.matchAll(/\btools\.([A-Za-z0-9_]+)\s*\(/g),m=>m[1]))].slice(0,24);
        for(const tool of names){const child=hash(id+':'+tool);this.record({id:child,taskId:task.id,time:stamp,name:tool,...provenance(tool),type:'tool',status:'observed',durationMs:null,parentCallId:id,evidence:'script'});}
      }
      const skills=[...new Set(Array.from(code.matchAll(/(?:[A-Za-z]:)?[\\/\w. :+@-]*[\\/]skills[\\/][^'"\r\n]*?SKILL\.md/gi),m=>m[0].replace(/\\\\/g,'\\').trim()))].slice(0,12);
      for(const skillPath of skills){const segments=skillPath.replace(/\\/g,'/').split('/');const label=safe(segments.at(-2),80);if(!label)continue;const plugin=segments.includes('sites')?'Sites':segments.includes('google-drive')?'Google Drive':null;
        const child=hash(id+':skill:'+label);this.record({id:child,taskId:task.id,time:stamp,name:label,plugin,server:null,provenance:'skill-path',type:'skill',status:'observed',durationMs:null,parentCallId:id,evidence:'script'});
      }
      return;
    }
    if(p.type==='function_call_output'||p.type==='custom_tool_call_output'){
      const id=this.pending.get(task.id+':'+p.call_id);const event=this.events.get(id)||this.inflight.get(id)||this.store?.findCall(task.id,p.call_id);if(!event)return;
      // A yielded exec is still running. A tool result alone does not prove domain-level success.
      const raw=typeof p.output==='string'?p.output:'';
      const cell=raw.match(/Script running with cell ID\s+([\w-]+)/);const session=raw.match(/"session_id"\s*:\s*(\d+)/);
      const yielded=Boolean(cell)||/(^|\.)(exec_command|write_stdin)$/.test(event.name)&&Boolean(session);
      const sourceId=this.waitTargets.get(event.id)||event.sourceEventId;
      if(cell)this.cells.set(task.id+':cell:'+cell[1],sourceId||event.id);
      if(session&&/(^|\.)(exec_command|write_stdin)$/.test(event.name))this.cells.set(task.id+':session:'+session[1],sourceId||event.id);
      const failed=p.is_error===true||p.status==='failed'||/"isError"\s*:\s*true|"exit_code"\s*:\s*[1-9]|Process exited with code [1-9]|Script failed/.test(raw);
      const waiting=/(^|\.)(wait|write_stdin)$/.test(event.name);
      event.status=yielded&&!waiting?'running':failed?'failed':'completed';event.completedAt=yielded&&!waiting?null:stamp;
      event.durationMs=yielded&&!waiting?null:Math.max(0,Date.parse(stamp)-Date.parse(event.time));this.revision++;
      this.record(event);
      if(sourceId&&!yielded){const source=this.events.get(sourceId)||this.inflight.get(sourceId)||this.store?.findEvent(sourceId);if(source){source.status=event.status;source.completedAt=stamp;source.durationMs=Math.max(0,Date.parse(stamp)-Date.parse(source.time));this.record(source);}for(const [key,value]of this.cells)if(value===sourceId)this.cells.delete(key);}this.waitTargets.delete(event.id);
      if(!yielded)this.pending.delete(task.id+':'+p.call_id);
    }
  }
  async readTitles(){
    try{const g=JSON.parse(await fs.readFile(path.join(this.codexHome,'.codex-global-state.json'),'utf8'));
      const atoms=g['electron-persisted-atom-state']||{};
      const source=g['thread-titles']?.titles||g['thread-titles-v1']?.titles||g['thread-titles-v1']||{};
      for(const [id,t]of Object.entries(source))if(typeof t==='string')this.titles[id]=safe(t,100);
      for(const [id,t]of Object.entries(atoms['thread-descriptions-v1']||g['thread-descriptions-v1']||{}))if(!this.titles[id])this.titles[id]=safe(typeof t==='string'?t:t?.title,100);
      for(const task of this.tasks.values())if(this.titles[task.id])task.title=this.titles[task.id];
    }catch{}
  }
  async discover(){
    const candidates=[];
    if(!this.catalog||this.scanCount%15===1){try{const dir=path.join(this.codexHome,'sessions');const entries=await fs.readdir(dir,{recursive:true});this.catalog=entries.filter(f=>/^rollout-.*\.jsonl$/.test(path.basename(f))).map(f=>path.join(dir,f));}catch{this.catalog=[];}}
    const cutoff=Date.now()-this.days*86400000;
    for(let i=0;i<this.catalog.length;i+=32){const batch=await Promise.allSettled(this.catalog.slice(i,i+32).map(async file=>{const st=await fs.stat(file);return {file,mtime:st.mtimeMs,size:st.size};}));for(const r of batch)if(r.status==='fulfilled'&&r.value.mtime>=cutoff)candidates.push(r.value);}
    this.candidateCount=candidates.length;const unread=candidates.filter(f=>f.size>(this.files.get(f.file)?.offset??this.store?.position(f.file)??0));
    unread.sort((a,b)=>(this.lastServed.get(a.file)||0)-(this.lastServed.get(b.file)||0)||b.mtime-a.mtime);
    const chosen=unread.slice(0,this.maxFiles);for(const f of chosen)this.lastServed.set(f.file,this.scanCount);this.deferredFiles=Math.max(0,unread.length-chosen.length);return chosen;
  }
  async readFile(info){
    if(!this.tasks.has(info.file)&&this.store){const saved=this.store.findSource(info.file);if(saved){this.tasks.set(info.file,saved.task);this.files.set(info.file,{offset:saved.offset,partial:Buffer.alloc(0)});}}
    let cursor=this.files.get(info.file);const initial=!cursor||!this.tasks.has(info.file)||info.size<cursor.offset;
    if(initial){cursor={offset:0,partial:''};this.files.set(info.file,cursor);}
    if(info.size===cursor.offset)return;
    const fh=await fs.open(info.file,'r');
    try{
      const size=Math.min(info.size-cursor.offset,4*1024*1024);const buffer=Buffer.alloc(size);const {bytesRead}=await fh.read(buffer,0,size,cursor.offset);cursor.offset+=bytesRead;
      // Buffer the last line as bytes so split UTF-8 characters remain intact.
      const combined=Buffer.concat([Buffer.isBuffer(cursor.partial)?cursor.partial:Buffer.from(cursor.partial),buffer.subarray(0,bytesRead)]);
      let begin=0;if(cursor.discard){const first=combined.indexOf(10);if(first<0){cursor.partial=combined;return;}begin=first+1;cursor.discard=false;}
      let end;while((end=combined.indexOf(10,begin))>=0){if(end-begin<64*1024*1024)this.consume(combined.subarray(begin,end).toString('utf8'),info.file);else this.oversizeRecords++;begin=end+1;}
      cursor.partial=combined.subarray(begin);if(cursor.partial.length>64*1024*1024){this.oversizeRecords++;cursor.partial=Buffer.alloc(0);cursor.discard=true;}
    }finally{await fh.close();}
  }
  async scan(){
    if(this.scanning)return;this.scanning=true;
    try{if(this.scanCount++%15===0)await this.readTitles();const files=await this.discover();for(const info of files){try{await this.readFile(info);}catch{this.errors++;}}
      const retained=new Set(files.map(f=>f.file));for(const file of this.files.keys())if(!retained.has(file)){this.files.delete(file);this.tasks.delete(file);}
      if(this.store){this.store.save(this.tasks,[...this.dirtyEvents].map(id=>this.events.get(id)).filter(Boolean),this.files,this.cells);this.dirtyEvents.clear();}
      if(this.events.size>6000){const ordered=[...this.events.values()].sort((a,b)=>Date.parse(a.time)-Date.parse(b.time));for(const event of ordered.slice(0,ordered.length-6000))this.events.delete(event.id);}
      for(const [key,id]of this.pending)if(!this.events.has(id)&&!this.inflight.has(id))this.pending.delete(key);
      this.updatedAt=new Date().toISOString();
    }finally{this.scanning=false;}
  }
  snapshot(){
    const now=Date.now();const tasks=(this.store?this.store.recentTasks():[...this.tasks.values()]).map(({historyStart,...t})=>({...t,status:t.status==='running'&&now-Date.parse(t.lastEventAt)>15*60*1000?'stale':t.status})).sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt));
    const events=[...this.events.values()].sort((a,b)=>Date.parse(a.time)-Date.parse(b.time)).slice(-2500).map(e=>({...e,plugin:({'unified-computer-use':'Computer Use','codex-app-tools':'Codex app tools'})[e.plugin]||e.plugin||provenance(e.name).plugin}));
    return {generatedAt:this.updatedAt,revision:this.revision,totals:this.store?.totals()||{tasks:tasks.length,events:events.length},source:{kind:'local',label:'Codex ローカル実行記録',storage:this.store?'sqlite':'memory',pollMs:2000,files:this.candidateCount||this.files.size,deferredFiles:this.deferredFiles||0,oversizeRecords:this.oversizeRecords,readErrors:this.errors,coverage:'SQLiteにメタデータを蓄積。直近2日以内に更新されたログを追跡。画面は100タスク / 2500イベント。'},tasks,events};
  }
}
