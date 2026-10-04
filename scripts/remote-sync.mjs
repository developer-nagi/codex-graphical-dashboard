import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {projectSnapshot,makePatch,MAX_SYNC_BYTES} from '../site/sync-protocol.mjs';

function readProtectedCredentials(root){return new Promise((resolve,reject)=>{
 const child=spawn('pwsh',['-NoProfile','-File',path.join(root,'scripts','remote-secret.ps1'),'-Mode','Read','-Path',path.join(root,'.runtime','remote-sync.secret')],{windowsHide:true,stdio:['ignore','pipe','pipe']});let text='';child.stdout.on('data',b=>text+=b.toString());child.on('error',()=>reject(new Error('credential_unavailable')));child.on('close',code=>{try{if(code)throw new Error();resolve(JSON.parse(text));}catch{reject(new Error('credential_unavailable'));}});
});}
export class RemoteSync {
 constructor({origin,apiToken,syncKey,getSnapshot,fetchImpl=fetch,statusPath=null,intervalMs=10000}){this.origin=origin;this.apiToken=apiToken;this.syncKey=syncKey;this.getSnapshot=getSnapshot;this.fetch=fetchImpl;this.statusPath=statusPath;this.intervalMs=intervalMs;this.baseline=null;this.digest=null;this.state={enabled:true,connected:false,lastSyncedAt:null,lastError:null,failures:0,intervalMs};}
 status(){return {...this.state};}
 async tick(){
  if(this.busy)return;this.busy=true;
  try{
   const snapshot=projectSnapshot(await this.getSnapshot());let patch=makePatch(this.baseline,snapshot,this.digest);
   for(let attempt=0;attempt<2;attempt++){
    const body=JSON.stringify(patch);if(Buffer.byteLength(body)>MAX_SYNC_BYTES)throw new Error('payload_too_large');
    const response=await this.fetch(new URL('/api/sync',this.origin),{method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),headers:{'Content-Type':'application/json','OAI-Sites-Authorization':'Bearer '+this.apiToken,'X-Trace-Key':this.syncKey},body});
    if(response.status===409&&attempt===0){patch=makePatch(null,snapshot,null);continue;}
    if(!response.ok)throw new Error('HTTP_'+response.status);
    const ack=await response.json();if(!ack.accepted||typeof ack.digest!=='string')throw new Error('invalid_ack');
    this.baseline=snapshot;this.digest=ack.digest;this.state={...this.state,connected:true,lastSyncedAt:ack.receivedAt,lastError:null,lastUploadBytes:Buffer.byteLength(body),remoteDigest:ack.digest};break;
   }
  }catch(error){this.state={...this.state,connected:false,lastError:/^(HTTP_\d+|payload_too_large|invalid_ack|invalid_source)$/.test(error.message)?error.message:'connection_failed',failures:this.state.failures+1};}
  finally{this.busy=false;if(this.statusPath)await fs.writeFile(this.statusPath,JSON.stringify(this.state)).catch(()=>{});}
 }
 start(){this.tick();this.timer=setInterval(()=>this.tick(),this.intervalMs);}
 stop(){clearInterval(this.timer);}
}
export async function createRemoteSync(root,getSnapshot){
 let configured=false;try{const config=JSON.parse(await fs.readFile(path.join(root,'.runtime','remote-sync.json'),'utf8'));if(!config.enabled)return null;configured=true;const url=new URL(config.origin);if(url.protocol!=='https:'||!url.hostname.endsWith('.chatgpt.site')||url.username||url.password)throw new Error();const credentials=await readProtectedCredentials(root);if(!credentials.apiToken||!/^[a-f0-9]{64}$/.test(credentials.syncKey))throw new Error();return new RemoteSync({origin:url.origin,...credentials,getSnapshot,statusPath:path.join(root,'.runtime','remote-status.json'),intervalMs:10000});}
 catch{return configured?{start(){},stop(){},status(){return {enabled:true,connected:false,lastError:'credential_unavailable'};}}:null;}
}
