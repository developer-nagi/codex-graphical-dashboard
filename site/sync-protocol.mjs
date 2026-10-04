export const MAX_SYNC_BYTES=1900000;
const taskFields=['id','title','parentId','forkedFromId','status','model','updatedAt','lastEventAt','source'];
const eventFields=['id','callId','taskId','targetTaskId','time','name','plugin','server','provenance','type','status','durationMs','parentCallId','sourceEventId','evidence','completedAt'];
const sourceFields=['kind','label','storage','pollMs','files','deferredFiles','oversizeRecords','readErrors','coverage'];
const totalFields=['tasks','records','events','skills'];
function pick(value,fields){const result={};for(const key of fields){const v=value?.[key];if(v===null||typeof v==='string'||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v))result[key]=typeof v==='string'?v.slice(0,600):v;}return result;}
function records(values,fields,max){if(!Array.isArray(values)||values.length>max)throw new Error('record_limit');const seen=new Set();return values.map(v=>{const r=pick(v,fields);if(typeof r.id!=='string'||!r.id||seen.has(r.id))throw new Error('record_identity');seen.add(r.id);return r;}).sort((a,b)=>a.id.localeCompare(b.id));}
export function projectSnapshot(value){
 if(!value||value.source?.kind!=='local'||!Number.isFinite(Date.parse(value.generatedAt)))throw new Error('invalid_source');
 return {generatedAt:new Date(value.generatedAt).toISOString(),revision:Number.isFinite(value.revision)?value.revision:0,source:pick(value.source,sourceFields),totals:pick(value.totals,totalFields),tasks:records(value.tasks,taskFields,100),events:records(value.events,eventFields,2500)};
}
export function makePatch(previous,next,baseDigest){
 if(!previous||!baseDigest)return {mode:'full',snapshot:next};
 const changes=(before,after)=>{const old=new Map(before.map(x=>[x.id,JSON.stringify(x)])),ids=new Set(after.map(x=>x.id));return {upserts:after.filter(x=>old.get(x.id)!==JSON.stringify(x)),removed:before.filter(x=>!ids.has(x.id)).map(x=>x.id)};};
 return {mode:'delta',baseDigest,generatedAt:next.generatedAt,revision:next.revision,source:next.source,totals:next.totals,tasks:changes(previous.tasks,next.tasks),events:changes(previous.events,next.events)};
}
export function applyPatch(previous,patch){
 if(patch?.mode==='full')return projectSnapshot(patch.snapshot);
 if(patch?.mode!=='delta'||!previous)throw new Error('full_required');
 const merge=(old,delta,max)=>{if(!delta||!Array.isArray(delta.upserts)||!Array.isArray(delta.removed)||delta.upserts.length>max||delta.removed.length>max)throw new Error('invalid_delta');const values=new Map(old.map(x=>[x.id,x]));for(const id of delta.removed)values.delete(id);for(const row of delta.upserts)values.set(row.id,row);return [...values.values()];};
 return projectSnapshot({generatedAt:patch.generatedAt,revision:patch.revision,source:patch.source,totals:patch.totals,tasks:merge(previous.tasks,patch.tasks,100),events:merge(previous.events,patch.events,2500)});
}
export async function snapshotDigest(value){const bytes=new TextEncoder().encode(JSON.stringify(value));const hash=await crypto.subtle.digest('SHA-256',bytes);return [...new Uint8Array(hash)].map(x=>x.toString(16).padStart(2,'0')).join('');}
