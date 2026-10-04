import test from 'node:test';
import assert from 'node:assert/strict';
import '../site/dist/graph-model.js';

const {identity,resources,wrapLabel,layout,edgeVisible,visibleTasks,visibleSelection,visibleGraphEvents}=globalThis.TraceGraph;
const event=(id,name,extra={})=>({id,name,type:'tool',taskId:'root',evidence:'log',time:'2026-10-04T05:00:00Z',status:'completed',...extra});

test('skills and MCP operations each keep their concrete name',()=>{
 const items=resources([event('s1','sites-building',{type:'skill'}),event('s2','sites-hosting',{type:'skill'}),event('m1','mcp__codex_apps.sites.create_site'),event('m2','mcp__codex_apps.sites.get_site')]);
 assert.equal(items.length,4);
 assert.deepEqual(new Set(items.map(i=>i.label)),new Set(['sites-building','sites-hosting','sites.create_site','sites.get_site']));
});
test('equivalent record spellings share only the same function and preserve evidence',()=>{
 const items=resources([event('a','mcp__codex_apps__sites_create_site',{evidence:'script'}),event('b','mcp__codex_apps.sites.create_site',{plugin:'Sites'}),event('c','mcp__codex_apps.sites.get_site')]);
 assert.equal(items.length,2);const create=items.find(i=>i.label==='sites.create_site');
 assert.equal(create.confirmedCount,1);assert.equal(create.detectedCount,1);assert.equal(create.event.id,'b');
 assert.equal(identity(event('x','exec_command')).key,identity(event('y','functions.exec_command')).key);
 assert.notEqual(identity(event('x','mcp__custom.foo_bar')).key,identity(event('y','mcp__custom.foo.bar')).key);
});
test('all function nodes remain available beyond the previous 12-node limit',()=>{
 const items=resources(Array.from({length:70},(_,i)=>event(String(i),`mcp__codex_apps.sites.function_${i}`)));
 const graph=layout([{id:'root',kind:'task',label:'親タスク',meta:'実行中'}],items,980);
 assert.equal(items.length,70);assert.equal(graph.nodes.length,71);assert.ok(graph.bounds.maxX>1280);
 for(const node of graph.nodes)assert.equal(node.titleLines.join(''),node.label);
});
test('long Japanese and function names wrap without truncation or overlapping boxes',()=>{
 const name='sites.create_source_repository_write_credential_with_a_very_long_function_name';
 const measure=(text,size)=>Array.from(text).reduce((n,c)=>n+(c.charCodeAt(0)>255?size:size*.6),0);
 const lines=wrapLabel(name,180,19,measure);assert.equal(lines.join(''),name);assert.ok(lines.length>1);for(const line of lines)assert.ok(measure(line,19)<=180);
 const taskTitle='長い日本語のタスク名と処理の流れを省略せずに表示する'.repeat(2);
 const graph=layout([{id:'root',kind:'task',label:taskTitle,meta:'実行中 / Codex'}],resources(Array.from({length:30},(_,i)=>event(String(i),name+i))),980,measure);
 for(const node of graph.nodes){assert.equal(node.titleLines.join(''),node.label);assert.ok(node.y+node.h<=980);}
 for(let i=0;i<graph.nodes.length;i++)for(let j=i+1;j<graph.nodes.length;j++){const a=graph.nodes[i],b=graph.nodes[j];assert.ok(a.x+a.w<=b.x||b.x+b.w<=a.x||a.y+a.h<=b.y||b.y+b.h<=a.y);}
});
test('agent lifecycle stays a link while callable agent functions get their own node',()=>{
 const items=resources([event('call','collaboration.spawn_agent',{type:'agent',callId:'rpc'}),event('activity','collaboration.started',{type:'agent',targetTaskId:'child'})]);
 assert.equal(items.length,1);assert.equal(items[0].label,'collaboration.spawn_agent');
});
test('routes stay visible when their destination is outside the viewport',()=>{
 const view={left:0,right:1280,top:0,bottom:740};
 assert.equal(edgeVisible({p0:[330,120],p1:[900,120],p2:[1100,240],p3:[1600,240]},view),true);
 assert.equal(edgeVisible({p0:[-300,120],p1:[400,120],p2:[900,240],p3:[1600,240]},view),true);
 assert.equal(edgeVisible({p0:[1600,120],p1:[1900,120],p2:[2100,240],p3:[2400,240]},view),false);
});
test('only completed subtasks are hidden, while active grandchildren and history remain intact',()=>{
 const tasks=[{id:'root',status:'running',parentId:null},{id:'done',status:'completed',parentId:'root'},{id:'active',status:'running',parentId:'done'},{id:'failed',status:'failed',parentId:'root'},{id:'closed-root',status:'completed',parentId:null}];
 const events=[event('r','functions.exec'),event('d','child-only',{taskId:'done'}),event('g','grandchild-tool',{taskId:'active'}),event('activity','collaboration.completed',{targetTaskId:'done'})];
 assert.deepEqual(visibleTasks(tasks).map(t=>t.id),['root','active','failed','closed-root']);
 assert.equal(visibleSelection(tasks,'done'),'root');assert.equal(visibleSelection(tasks,'active'),'active');
 assert.deepEqual(visibleGraphEvents(tasks,events).map(e=>e.id),['r','g']);
 assert.equal(tasks.length,5);assert.equal(events.length,4);assert.equal(tasks[1].status,'completed');
});
test('selection falls back through hidden ancestors and handles an empty display',()=>{
 const tasks=[{id:'root',status:'running',parentId:null},{id:'a',status:'completed',parentId:'root'},{id:'b',status:'completed',parentId:'a'}];
 assert.equal(visibleSelection(tasks,'b'),'root');assert.equal(visibleSelection([], 'b'),undefined);
});
