'use strict';
// Function identity is independent of record spelling and of evidence strength.
globalThis.TraceGraph = (() => {
  const functionTools = new Set(['exec','exec_command','apply_patch','wait','write_stdin','request_user_input','request_user_input_async','create_goal','get_goal','update_goal','view_image','list_mcp_resources','list_mcp_resource_templates','read_mcp_resource']);
  const appPrefixes = ['plugin_management','chatgpt_space','google_drive','elevenlabs','tavily','sites'];
  const latestTime = e => Date.parse(e.completedAt || e.time) || 0;
  function identity(event) {
    const name = String(event.name || 'unknown');
    if (event.type === 'skill') return {key:'skill:'+name, kind:'skill', label:name, canonicalName:name};
    const mcp = name.match(/^mcp__([A-Za-z0-9_]+?)(?:__|\.)(.+)$/);
    if (mcp) {
      const server = mcp[1]; let operation = mcp[2];
      if (server === 'codex_apps') {
        const prefix = appPrefixes.find(p => operation.startsWith(p+'_'));
        if (prefix) operation = prefix+'.'+operation.slice(prefix.length+1);
      }
      const canonicalName = `mcp__${server}.${operation}`;
      return {key:'mcp:'+canonicalName, kind:'mcp', label:server==='codex_apps'?operation:server+'.'+operation, server, canonicalName};
    }
    const canonicalName = functionTools.has(name) ? 'functions.'+name : name.replace(/^(web|clock|image_gen)__/, '$1.');
    return {key:'tool:'+canonicalName, kind:'tool', label:canonicalName, canonicalName};
  }
  function resources(events) {
    const groups = new Map();
    for (const event of events) {
      // Parent/child lifecycle records are edges, rather than tool functions.
      if (event.type === 'agent' && !event.callId && event.evidence !== 'demo') continue;
      const info = identity(event);
      if (!groups.has(info.key)) groups.set(info.key, {...info, id:info.key, events:[]});
      groups.get(info.key).events.push(event);
    }
    for (const group of groups.values()) {
      group.events.sort((a,b) => latestTime(a)-latestTime(b));
      group.event = [...group.events].reverse().find(e => e.evidence !== 'script') || group.events.at(-1);
      group.plugin = group.event.plugin || [...group.events].reverse().find(e => e.plugin)?.plugin || null;
      group.confirmedCount = group.events.filter(e => e.evidence !== 'script').length;
      group.detectedCount = group.events.length - group.confirmedCount;
    }
    const order = {mcp:0, skill:1, tool:2};
    return [...groups.values()].sort((a,b) => order[a.kind]-order[b.kind] || a.canonicalName.localeCompare(b.canonicalName));
  }
  function estimatedWidth(text,size) {
    return Array.from(text).reduce((sum,c) => sum+(/[^\x00-\xff]/.test(c) ? size : /[MW@]/.test(c) ? size*.92 : size*.57),0);
  }
  function wrapLabel(text,width,size=19,measure=estimatedWidth) {
    const chars = Array.from(String(text)); const lines = []; let start = 0;
    while (start < chars.length) {
      let end = start; let preferred = -1;
      while (end < chars.length && measure(chars.slice(start,end+1).join(''),size) <= width) {
        if (/[_.\-/]/.test(chars[end])) preferred = end+1;
        end++;
      }
      if (end === start) end++;
      if (end < chars.length && preferred > start+(end-start)/2) end = preferred;
      lines.push(chars.slice(start,end).join('')); start=end;
    }
    return lines.length ? lines : [''];
  }
  function layout(tasks,functions,height=980,measure=estimatedWidth) {
    const nodes=[]; const bottom=height-80; const gap=20; const columnGap=42;
    function columns(items,startX,width) {
      let x=startX,y=64;
      for (const item of items) {
        const titleLines=wrapLabel(item.label,width-32,19,measure);
        const metaLines=wrapLabel(item.meta,width-32,16,measure);
        const h=44+titleLines.length*22+metaLines.length*19+12;
        if (y+h>bottom && y>64) {x+=width+columnGap;y=64;}
        nodes.push({...item,x,y,w:width,h,titleLines,metaLines}); y+=h+gap;
      }
      return items.length ? x+width+columnGap : startX;
    }
    const endTasks=columns(tasks,40,290);
    let x=endTasks+56;
    for (const kind of ['mcp','skill','tool']) {
      const items=functions.filter(f=>f.kind===kind).map(f=>({...f,
        meta:[f.server,f.plugin,`${f.confirmedCount}件の実行記録`,f.detectedCount?`${f.detectedCount}件の記述`:null].filter(Boolean).join(' / ')}));
      x=columns(items,x,360);
    }
    const bounds={minX:40,minY:64,maxX:Math.max(40,...nodes.map(n=>n.x+n.w)),maxY:Math.max(64,...nodes.map(n=>n.y+n.h))};
    return {nodes,bounds};
  }
  function edgeVisible(edge,view) {
    const points=[edge.p0,edge.p1,edge.p2,edge.p3];
    return Math.max(...points.map(p=>p[0]))>=view.left && Math.min(...points.map(p=>p[0]))<=view.right && Math.max(...points.map(p=>p[1]))>=view.top && Math.min(...points.map(p=>p[1]))<=view.bottom;
  }
  function visibleTasks(tasks) {
    return tasks.filter(task=>!(task.parentId&&task.status==='completed'));
  }
  function visibleSelection(tasks,selected) {
    const visible=visibleTasks(tasks),ids=new Set(visible.map(t=>t.id)),byId=new Map(tasks.map(t=>[t.id,t]));
    let current=byId.get(selected);const visited=new Set();
    while(current&&!ids.has(current.id)&&!visited.has(current.id)){visited.add(current.id);current=byId.get(current.parentId);}
    return current&&ids.has(current.id)?current.id:visible.find(t=>t.status==='running'&&!t.parentId)?.id||visible.find(t=>!t.parentId)?.id||visible[0]?.id;
  }
  function visibleGraphEvents(tasks,events) {
    const ids=new Set(visibleTasks(tasks).map(t=>t.id));
    return events.filter(e=>ids.has(e.taskId)&&(!e.targetTaskId||ids.has(e.targetTaskId)));
  }
  return {identity,resources,wrapLabel,layout,edgeVisible,visibleTasks,visibleSelection,visibleGraphEvents};
})();
