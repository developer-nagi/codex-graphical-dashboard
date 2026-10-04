import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
console.log('Ready for remote configuration JSON on stdin (input is hidden).');
if(process.stdin.isTTY)process.stdin.setRawMode(true);
const input=await new Promise(resolve=>{let value='';process.stdin.on('data',b=>{value+=b.toString();const index=value.search(/[\r\n]/);if(index>=0){process.stdin.pause();resolve(value.slice(0,index));}});});
if(process.stdin.isTTY)process.stdin.setRawMode(false);
try{
 const data=JSON.parse(input),url=new URL(data.origin);if(url.protocol!=='https:'||!url.hostname.endsWith('.chatgpt.site')||url.username||url.password||!data.apiToken||!/^[a-f0-9]{64}$/.test(data.syncKey))throw new Error();
 await fs.mkdir(path.join(root,'.runtime'),{recursive:true});
 await new Promise((resolve,reject)=>{const child=spawn('pwsh',['-NoProfile','-File',path.join(root,'scripts','remote-secret.ps1'),'-Mode','Protect','-Path',path.join(root,'.runtime','remote-sync.secret')],{windowsHide:true,stdio:['pipe','ignore','pipe']});child.on('error',reject);child.on('close',code=>code?reject(new Error()):resolve());child.stdin.end(JSON.stringify({apiToken:data.apiToken,syncKey:data.syncKey}));});
 const configPath=path.join(root,'.runtime','remote-sync.json');await fs.writeFile(configPath+'.new',JSON.stringify({enabled:true,origin:url.origin,intervalMs:10000}));await fs.rename(configPath+'.new',configPath);
 console.log('Remote configuration saved; credentials protected for this Windows user.');
}catch{console.error('Remote configuration failed. No credential values were printed.');process.exitCode=1;}
