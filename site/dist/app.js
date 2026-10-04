'use strict';
const $=id=>document.getElementById(id);
const state={data:null,selected:null,event:null,filter:'all',mode:'live',paused:false,history:[],cursor:null,historyLoaded:false};
const fmt=new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
const time=v=>v?fmt.format(new Date(v)):'—';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const statuses={running:'実行中',completed:'応答済み',failed:'失敗',interrupted:'中断',idle:'待機',unknown:'未確認',observed:'記述を検出',stale:'更新なし'};
const base=location.hostname==='127.0.0.1'||location.hostname==='localhost'?'':'http://127.0.0.1:4318';
let renderer;
const nodePositions=new Map();let view={zoom:1,pan:[0,0]},drag=null,suppressClick=false;
try{renderer=new FlowRenderer($('flow-canvas'),ok=>{$('graph-stage').classList.toggle('webgl-active',ok);$('renderer-label').textContent=ok?'WEBGL / GPU':'SVG / FALLBACK';});}catch{$('renderer-label').textContent='SVG / FALLBACK';}
function demoData(){const now=Date.now();const tasks=[{id:'demo-root',title:'Codex 実行経路モニター',status:'running',parentId:null,model:'主担当',updatedAt:new Date(now).toISOString()},{id:'demo-a',title:'接続情報を調査',status:'running',parentId:'demo-root',model:'explorer',updatedAt:new Date(now-1000).toISOString()},{id:'demo-b',title:'画面を構築',status:'running',parentId:'demo-root',model:'worker',updatedAt:new Date(now-2000).toISOString()},{id:'demo-c',title:'動作を検証',status:'completed',parentId:'demo-root',model:'tester',updatedAt:new Date(now-3000).toISOString()}];const specs=[['demo-root','functions.exec',null,null,'running','tool'],['demo-root','sites-building','Sites',null,'completed','skill'],['demo-b','mcp__codex_apps.sites.create_site','Sites','codex_apps','completed','tool'],['demo-a','mcp__codex_app.read_thread','Codex app tools','codex_app','completed','tool'],['demo-c','mcp__cua_repl.js','Computer Use','cua_repl','completed','tool'],['demo-root','collaboration.spawn_agent',null,null,'completed','agent'],['demo-root','openai-docs',null,null,'completed','skill']];return {generatedAt:new Date(now).toISOString(),source:{kind:'demo'},tasks,events:specs.map((s,i)=>({id:'demo-e'+i,taskId:s[0],name:s[1],plugin:s[2],server:s[3],status:s[4],type:s[5],time:new Date(now-1000*i).toISOString(),completedAt:new Date(now).toISOString(),durationMs:s[4]==='completed'?155+i*94:null,evidence:'demo',targetTaskId:s[5]==='agent'?'demo-a':null}))};}
function descendants(id){const ids=new Set([id]);let changed=true;while(changed){changed=false;for(const t of state.data?.tasks||[])if(ids.has(t.parentId)&&!ids.has(t.id)){ids.add(t.id);changed=true;}}return ids;}
function familyEvents(){const ids=descendants(state.selected);const all=new Map();for(const e of [...state.history,...(state.data?.events||[])])if(ids.has(e.taskId))all.set(e.id,e);return [...all.values()].sort((a,b)=>Date.parse(a.time)-Date.parse(b.time)||a.id.localeCompare(b.id));}
function selectTask(id){if(state.selected!==id)view={zoom:1,pan:[0,0]};state.selected=id;state.event=null;state.history=[];state.cursor=null;state.historyLoaded=false;render();}
function selectEvent(id){state.event=familyEvents().find(e=>e.id===id)||null;renderRoute();}
function render(){if(!state.data)return;const tasks=state.data.tasks,events=state.data.events;if(!tasks.some(t=>t.id===state.selected))state.selected=tasks.find(t=>t.status==='running'&&!t.parentId)?.id||tasks.find(t=>!t.parentId)?.id||tasks[0]?.id;
 $('m-tasks').textContent=tasks.filter(t=>t.status==='running').length;$('m-subtasks').textContent=`サブタスク ${tasks.filter(t=>t.parentId).length}`;$('m-calls').textContent=state.data.totals?.events??events.filter(e=>e.type==='tool'&&e.evidence!=='script').length;$('m-skills').textContent=new Set(events.filter(e=>e.type==='skill').map(e=>e.name)).size;$('m-mcp').textContent=new Set(events.filter(e=>e.server&&e.evidence!=='script').map(e=>e.server)).size;
 $('last-update').textContent=time(state.data.generatedAt);$('source-age').textContent=state.mode==='demo'?'サンプル / 実記録ではありません':`${time(state.data.generatedAt)} · SQLite · 2秒間隔`;$('coverage').textContent=state.mode==='demo'?'DEMO / サンプルデータ':'SQLiteに蓄積 · 参照指示と実行記録を区別';renderTasks();renderGraph();renderEvents();renderRoute();
}
function renderTasks(){const q=$('search').value.toLowerCase();const tasks=state.data.tasks.filter(t=>(t.title+' '+t.id).toLowerCase().includes(q));$('task-count').textContent=String(tasks.length).padStart(2,'0');const ordered=[],seen=new Set();function add(t,depth=0){if(seen.has(t.id))return;seen.add(t.id);ordered.push({...t,depth});tasks.filter(x=>x.parentId===t.id).forEach(x=>add(x,depth+1));}tasks.filter(t=>!t.parentId||!tasks.some(p=>p.id===t.parentId)).forEach(t=>add(t));tasks.forEach(t=>add(t));
 $('task-list').innerHTML=ordered.length?ordered.map(t=>`<button class="task-row ${t.id===state.selected?'selected':''} ${t.depth?'child':''}" data-task="${esc(t.id)}" aria-pressed="${t.id===state.selected}"><span class="task-top"><i class="task-status ${esc(t.status)}"></i>${t.depth?'SUBTASK':'TASK'} <span>${esc(t.status==='completed'?'完了':statuses[t.status]||t.status)}</span></span><span class="task-name">${esc(t.title)}</span><span class="task-meta">${esc(t.model||'Codex')} · ${time(t.updatedAt)}</span></button>`).join(''):'<p class="empty">該当するタスクがありません。</p>';
}
function shortLabel(text,width=238,size=19){let used=0,out='';for(const c of String(text)){used+=/[^\x00-\xff]/.test(c)?size:size*.57;if(used>width-size)return out+'…';out+=c;}return out;}
function resourceKey(e){return TraceGraph.identity(e).key;}
let graphBounds=null;
const measureContext=document.createElement('canvas').getContext('2d');
function measureLabel(text,size){if(!measureContext)return text.length*size;measureContext.font=size===19?"500 19px 'Noto Sans JP', sans-serif":`${size}px 'IBM Plex Mono', Consolas, monospace`;return measureContext.measureText(text).width;}
function renderGraph(){
 const svg=$('graph'),task=state.data.tasks.find(t=>t.id===state.selected);
 if(!task){svg.innerHTML='<text x="640" y="300" text-anchor="middle" fill="#8a9cac" font-size="18">タスクの記録を待っています</text>';return;}
 $('graph-title').textContent=task.title;
 const events=familyEvents(),eventById=new Map(events.map(e=>[e.id,e]));
 const resources=TraceGraph.resources(events);
 const members=state.data.tasks.filter(t=>descendants(task.id).has(t.id)).sort((a,b)=>a.id===task.id?-1:b.id===task.id?1:0);
 const height=Math.max(740,Math.round(svg.clientHeight/Math.max(1,svg.clientWidth)*1280));
 const tasks=members.map(t=>({id:t.id,kind:'task',label:t.title,meta:[t.status==='completed'?'完了':statuses[t.status]||t.status,t.model].filter(Boolean).join(' / '),task:t}));
 const {nodes,bounds}=TraceGraph.layout(tasks,resources,height,measureLabel);
 const byId=new Map(nodes.map(n=>[n.id,n])); const edges=[];
 const palette={task:'#58e6d2',skill:'#efc575',mcp:'#91dfa6',tool:'#9aaec8'};
 function edge(source,target,eventList,dashed){
  const latest=[...eventList].sort((a,b)=>Date.parse(b.completedAt||b.time)-Date.parse(a.completedAt||a.time))[0];
  const parent=source.kind==='task'&&target.kind==='task';
  const p0=[parent?source.x+12:source.x+source.w,source.y+source.h/2],p3=[parent?target.x+12:target.x,target.y+target.h/2];
  const distance=parent?-60:Math.max(80,Math.abs(p3[0]-p0[0])*.45);
  edges.push({source,target,event:latest,events:eventList,dashed,p0,p1:[p0[0]+distance,p0[1]],p2:[p3[0]-distance,p3[1]],p3,color:palette[target.kind].match(/[0-9a-f]{2}/g).map(c=>parseInt(c,16)/255)});
 }
 for(const node of nodes.filter(n=>n.task?.parentId)){
  const parent=byId.get(node.task.parentId);
  if(parent){const activity=events.filter(e=>e.targetTaskId===node.id);edge(parent,node,activity,activity.length===0);}
 }
 for(const node of nodes.filter(n=>n.events)){
  const routes=new Map();
  for(const event of node.events){
   const parent=eventById.get(event.parentCallId);let source=parent?byId.get(resourceKey(parent)):null;
   if(!source||source.id===node.id)source=byId.get(event.taskId);
   if(!source)continue;
   const dashed=event.evidence==='script';const key=source.id+':'+dashed;
   if(!routes.has(key))routes.set(key,{source,dashed,events:[]});routes.get(key).events.push(event);
  }
  for(const route of routes.values())edge(route.source,node,route.events,route.dashed);
 }
 for(const node of nodes){
  const pos=nodePositions.get(node.id);if(!pos)continue;
  const dx=pos[0]-node.x,dy=pos[1]-node.y;node.x=pos[0];node.y=pos[1];
  for(const e of edges){if(e.source===node){e.p0[0]+=dx;e.p0[1]+=dy;e.p1[0]+=dx;e.p1[1]+=dy;}if(e.target===node){e.p2[0]+=dx;e.p2[1]+=dy;e.p3[0]+=dx;e.p3[1]+=dy;}}
 }
 graphBounds={minX:Math.min(...nodes.map(n=>n.x)),minY:Math.min(...nodes.map(n=>n.y)),maxX:Math.max(...nodes.map(n=>n.x+n.w)),maxY:Math.max(...nodes.map(n=>n.y+n.h))};
 svg.setAttribute('viewBox',`0 0 1280 ${height}`);
 let markup=edges.map(e=>`<path class="flow ${e.dashed?'observed':''}" d="M ${e.p0.join(' ')} C ${e.p1.join(' ')},${e.p2.join(' ')},${e.p3.join(' ')}" stroke="${palette[e.target.kind]}"/>`).join('');
 markup+=nodes.map(n=>{
  const color=palette[n.kind];const metaY=n.y+44+n.titleLines.length*22;
  return `<g class="graph-node" data-node-id="${esc(n.id)}" role="button" tabindex="0" aria-label="${esc(n.label)}" ${n.task?`data-task="${esc(n.id)}"`:`data-event="${esc(n.event?.id||'')}"`}><rect class="node-hit" x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" fill="transparent"/><title>${esc(n.canonicalName||n.label)}</title><rect class="node-box" x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="5" fill="#111c29" stroke="${color}"/><text x="${n.x+16}" y="${n.y+21}" class="node-kind" fill="${color}">${n.kind==='task'?(n.task.parentId?'SUBTASK':'TASK'):n.kind.toUpperCase()}</text><text class="node-title" fill="#e1ebf3">${n.titleLines.map((line,i)=>`<tspan x="${n.x+16}" y="${n.y+46+i*22}">${esc(line)}</tspan>`).join('')}</text><text class="node-meta" fill="#8b9fb1">${n.metaLines.map((line,i)=>`<tspan x="${n.x+16}" y="${metaY+i*19}">${esc(line)}</tspan>`).join('')}</text></g>`;
 }).join('');
 if(!resources.length)markup+='<text x="500" y="200" fill="#8a9cac" font-size="17">呼び出しの記録はまだありません</text>';
 svg.innerHTML=`<g id="graph-world" transform="translate(${view.pan.join(' ')}) scale(${view.zoom})">${markup}</g>`;
 $('flow-count').textContent=`${resources.length} FUNCTIONS / ${edges.length} CONNECTIONS`;
 renderer?.setGraph(edges,1280,height,nodes,new Set(state.data.events.map(e=>e.id)));renderer?.setTransform(view.zoom,view.pan);svg.dataset.worldHeight=height;
}
function fitGraph(){
 if(!state.data)return;nodePositions.clear();renderGraph();
 if(!graphBounds)return;
 const height=Number($('graph').dataset.worldHeight||740);const width=graphBounds.maxX-graphBounds.minX+100,span=graphBounds.maxY-graphBounds.minY+100;
 view.zoom=Math.min(1,1280/width,height/span);view.pan=[640-(graphBounds.minX+graphBounds.maxX)*view.zoom/2,height/2-(graphBounds.minY+graphBounds.maxY)*view.zoom/2];updateView();
}
function renderEvents(){const events=(state.historyLoaded?[...state.history].sort((a,b)=>Date.parse(a.time)-Date.parse(b.time)):familyEvents()).filter(e=>state.filter==='all'||(state.filter==='failed'?e.status==='failed':e.type===state.filter)).slice(-200).reverse();$('event-count').textContent=familyEvents().length+' EVENTS';$('older').disabled=state.mode==='demo'||state.historyLoaded&&!state.cursor;$('event-list').innerHTML=events.length?events.map(e=>{const task=state.data.tasks.find(t=>t.id===e.taskId);return `<button class="event-row" data-event="${esc(e.id)}"><span class="event-heading"><span class="event-kind ${esc(e.type)}">${esc(e.server?'MCP':e.type.toUpperCase())}</span>${e.plugin?`<span class="event-plugin" title="${esc(e.plugin)}">${esc(e.plugin)}</span>`:''}<span class="event-time">${time(e.time)}</span></span><span class="event-name">${esc(e.name)}</span><span class="event-bottom"><span>${esc(task?.title||e.taskId.slice(0,12))}</span><span class="event-state ${esc(e.status)}">${esc(statuses[e.status]||e.status)}${Number.isFinite(e.durationMs)?' / '+e.durationMs+'ms':''}</span></span></button>`;}).join(''):'<p class="empty">このタスクの呼び出しはまだ記録されていません。</p>';}
function renderRoute(){const e=state.event;$('route').hidden=!e;if(!e){$('route').innerHTML='<span class="tiny-label">TRACE ANNOTATION</span><p>ノードを選ぶと、呼び出し元・状態・根拠を表示します。</p>';return;}const task=state.data.tasks.find(t=>t.id===e.taskId),parent=familyEvents().find(x=>x.id===e.parentCallId);const chain=[task?.title||'タスク',parent?.name,e.name].filter(Boolean);$('route').innerHTML=`<span class="tiny-label">TRACE ANNOTATION / ${time(e.time)}</span><div class="route-chain">${chain.map(c=>`<span class="route-chip">${esc(c)}</span>`).join('<span class="route-arrow">›</span>')}</div><div class="route-details">${e.plugin?'所属: '+esc(e.plugin)+' · ':''}${esc(statuses[e.status]||e.status)} · ${e.evidence==='script'?'コード内の記述。実行は未確認':e.evidence==='read'?'参照を含むコマンドの完了を記録':'実行記録を確認'}${Number.isFinite(e.durationMs)?' · '+e.durationMs+'ms':''}</div>`;}
function connection(ok,reason){$('connection').textContent=state.mode==='demo'?'DEMO':state.paused?'一時停止':ok?'LIVE / 接続済み':'未接続';$('connection').className='status-tag '+(state.mode==='demo'?'demo':ok?'':'off');$('notice').hidden=ok||state.mode==='demo';if(!ok)$('notice').innerHTML=`ローカル接続を確認できません。<a href="http://127.0.0.1:4318/" target="_blank" rel="noopener">このPCの監視画面を開く</a>。停止中の場合は start.ps1 でコレクターを起動してください。${reason?' '+esc(reason):''}`;}
let refreshing=false;
async function refresh(){if(refreshing||state.paused||state.mode==='demo')return;refreshing=true;try{const res=await fetch(base+'/api/snapshot',{cache:'no-store',signal:AbortSignal.timeout(6000)});if(!res.ok)throw new Error('HTTP '+res.status);const data=await res.json();if(!Array.isArray(data.tasks)||!Array.isArray(data.events))throw new Error('データ形式');if(state.mode==='live'&&!state.paused){state.data=data;if(state.event)state.event=data.events.find(e=>e.id===state.event.id)||state.event;render();connection(true);}}catch(e){if(state.mode==='live')connection(false,e.message);}finally{refreshing=false;}}
$('mode').addEventListener('click',()=>{state.mode=state.mode==='live'?'demo':'live';state.event=null;state.selected=null;state.history=[];state.historyLoaded=false;state.cursor=null;$('mode').textContent=state.mode==='demo'?'実データに戻る':'デモを見る';$('pause').disabled=state.mode==='demo';if(state.mode==='demo'){state.data=demoData();render();connection(true);}else{state.paused=false;renderer?.setPaused(false);$('pause').textContent='Ⅱ 一時停止';refresh();}});
$('pause').addEventListener('click',()=>{state.paused=!state.paused;renderer?.setPaused(state.paused);$('pause').textContent=state.paused?'▷ 再開':'Ⅱ 一時停止';connection(Boolean(state.data));if(!state.paused)refresh();});
function toggleHistory(open){document.body.classList.toggle('history-open',open);$('history-toggle').setAttribute('aria-expanded',String(open));}
$('history-toggle').addEventListener('click',()=>toggleHistory(!document.body.classList.contains('history-open')));$('history-close').addEventListener('click',()=>toggleHistory(false));
$('older').addEventListener('click',async()=>{if(!state.selected||state.mode==='demo')return;const selected=state.selected;const params=new URLSearchParams({taskId:selected,limit:'200'});if(state.cursor){params.set('before',state.cursor.time);params.set('beforeId',state.cursor.id);}else{const oldest=familyEvents()[0];if(oldest){params.set('before',oldest.time);params.set('beforeId',oldest.id);}}$('older').disabled=true;try{const res=await fetch(base+'/api/history?'+params,{signal:AbortSignal.timeout(6000)});if(!res.ok)throw new Error();const page=await res.json();if(selected===state.selected){state.history=page.events;state.cursor=page.cursor;state.historyLoaded=true;renderEvents();$('event-list').scrollTop=$('event-list').scrollHeight;}}catch{$('older').textContent='再試行';$('older').disabled=false;}});
$('search').addEventListener('input',()=>state.data&&renderTasks());document.addEventListener('click',e=>{if(suppressClick){suppressClick=false;return;}const node=e.target.closest('[data-task],[data-event],[data-filter]');if(!node)return;if(node.dataset.task)selectTask(node.dataset.task);if(node.dataset.event)selectEvent(node.dataset.event);if(node.dataset.filter){state.filter=node.dataset.filter;document.querySelectorAll('[data-filter]').forEach(b=>b.classList.toggle('active',b===node));if(state.data)renderEvents();}});
$('graph').addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){const node=e.target.closest('.graph-node');if(node){e.preventDefault();node.dispatchEvent(new MouseEvent('click',{bubbles:true}));}}});$('fit').addEventListener('click',fitGraph);document.addEventListener('keydown',e=>{if(e.key==='Escape')toggleHistory(false);});
setInterval(()=>{$('clock').textContent=time(Date.now())+' JST';if(state.mode==='demo')renderer?.demoPulse();},1000);setInterval(refresh,2000);$('clock').textContent=time(Date.now())+' JST';refresh();
if(document.modelContext?.registerTool){const lifecycle=new AbortController();window.addEventListener('pagehide',()=>lifecycle.abort(),{once:true});try{Promise.resolve(document.modelContext.registerTool({name:'select_trace_task',title:'タスクの処理経路を表示',description:'指定したタスクをこの画面で選び、処理経路と履歴を表示する。',inputSchema:{type:'object',properties:{taskId:{type:'string'}},required:['taskId'],additionalProperties:false},annotations:{readOnlyHint:false},execute(input){if(!input||typeof input.taskId!=='string'||Object.keys(input).some(k=>k!=='taskId')||!state.data?.tasks.some(t=>t.id===input.taskId))throw new Error('記録にある taskId を指定してください');selectTask(input.taskId);return {taskId:state.selected,connections:familyEvents().length};}},{signal:lifecycle.signal})).catch(()=>{});}catch{}}

function updateView(){document.getElementById('graph-world')?.setAttribute('transform',`translate(${view.pan.join(' ')}) scale(${view.zoom})`);renderer?.setTransform(view.zoom,view.pan);}
$('graph-stage').addEventListener('wheel',e=>{if(!state.data)return;e.preventDefault();const stage=$('graph-stage'),rect=stage.getBoundingClientRect(),worldHeight=Number($('graph').dataset.worldHeight||740),scale=Math.min($('graph').clientWidth/1280,$('graph').clientHeight/worldHeight);const anchor=[(e.clientX-rect.left+stage.scrollLeft-$('graph').clientWidth/2)/scale+640,(e.clientY-rect.top+stage.scrollTop-$('graph').clientHeight/2)/scale+worldHeight/2];const next=Math.max(.08,Math.min(2.5,view.zoom*Math.exp(-e.deltaY*.001)));view.pan=anchor.map((a,i)=>a-(a-view.pan[i])*next/view.zoom);view.zoom=next;updateView();},{passive:false});
$('graph-stage').addEventListener('pointerdown',e=>{if(e.button!==0||e.target.closest('.annotation'))return;const node=e.target.closest('.graph-node');const rect=node?.querySelector('rect');drag={pointer:e.pointerId,x:e.clientX,y:e.clientY,startX:e.clientX,startY:e.clientY,node:node?.dataset.task||node?.dataset.event,id:node?node.dataset.task||(node.dataset.event&&'event:'+node.dataset.event):null,box:rect?[Number(rect.getAttribute('x')),Number(rect.getAttribute('y'))]:null};});
$('graph-stage').addEventListener('pointermove',e=>{if(!drag||e.pointerId!==drag.pointer)return;const scale=Math.min($('graph').clientWidth/1280,$('graph').clientHeight/Number($('graph').dataset.worldHeight||740));const dx=(e.clientX-drag.x)/scale,dy=(e.clientY-drag.y)/scale;drag.x=e.clientX;drag.y=e.clientY;if(Math.hypot(e.clientX-drag.startX,e.clientY-drag.startY)>4){suppressClick=true;if(!drag.captured){$('graph-stage').setPointerCapture(e.pointerId);drag.captured=true;}}else if(!drag.captured)return;if(drag.id&&drag.box){const group=Array.from($('graph').querySelectorAll('.graph-node')).find(n=>n.dataset.task===drag.node||n.dataset.event===drag.node);const identity=group?.dataset.nodeId;if(identity){drag.box=[drag.box[0]+dx/view.zoom,drag.box[1]+dy/view.zoom];nodePositions.set(identity,drag.box);renderGraph();}}else{view.pan[0]+=dx;view.pan[1]+=dy;updateView();}});
$('graph-stage').addEventListener('pointerup',()=>{drag=null;});$('graph-stage').addEventListener('pointercancel',()=>{drag=null;suppressClick=false;});window.addEventListener('pagehide',()=>renderer?.destroy(),{once:true});

document.fonts?.ready.then(()=>{if(state.data)renderGraph();});
