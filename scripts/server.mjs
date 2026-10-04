import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {TelemetryCollector} from './collector.mjs';
import {TelemetryStore} from './store.mjs';
import {createRemoteSync} from './remote-sync.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const port=Number(process.env.CODEX_TRACE_PORT||4318);
const store=new TelemetryStore(path.join(root,'.runtime','telemetry.sqlite3'));
const collector=new TelemetryCollector({store});
const allowedOrigins=new Set([`http://127.0.0.1:${port}`,`http://localhost:${port}`]);
try{const config=JSON.parse(await fs.readFile(path.join(root,'.runtime','site-origin.json'),'utf8'));if(config.origin&&new URL(config.origin).protocol==='https:')allowedOrigins.add(new URL(config.origin).origin);}catch{}
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.svg':'image/svg+xml'};
await collector.scan();
const remoteSync=await createRemoteSync(root,()=>collector.snapshot());
remoteSync?.start();
const timer=setInterval(()=>collector.scan().catch(()=>{}),2000);
const server=http.createServer(async(req,res)=>{
  const origin=req.headers.origin;
  const host=req.headers.host;
  if(host!==`127.0.0.1:${port}`&&host!==`localhost:${port}`){res.writeHead(403);res.end('Invalid host');return;}
  if(origin&&!allowedOrigins.has(origin)){res.writeHead(403);res.end('Origin denied');return;}
  if(origin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Private-Network','true');}
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  if(req.method==='OPTIONS'){res.setHeader('Access-Control-Allow-Methods','GET, OPTIONS');res.writeHead(204);res.end();return;}
  if(req.method!=='GET'){res.writeHead(405);res.end('Read only');return;}
  try{const url=new URL(req.url,`http://127.0.0.1:${port}`);
    if(url.pathname==='/api/snapshot'){res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(collector.snapshot()));return;}
    if(url.pathname==='/api/history'){res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(store.history({taskId:url.searchParams.get('taskId'),before:url.searchParams.get('before'),beforeId:url.searchParams.get('beforeId')||'',limit:url.searchParams.get('limit')})));return;}
    if(url.pathname==='/api/health'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({service:'codex-trace',pid:process.pid,startedAt,source:collector.snapshot().source,remoteSync:remoteSync?.status()||{enabled:false}}));return;}
    const file=url.pathname==='/'?'index.html':url.pathname.slice(1);
    if(!['index.html','styles.css','app.js','graph-webgl.js','graph-model.js'].includes(file)){res.writeHead(404);res.end('Not found');return;}
    const content=await fs.readFile(path.join(root,'site','dist',file));res.setHeader('Content-Type',types[path.extname(file)]);res.end(content);
  }catch{res.writeHead(500);res.end('Read failed');}
});
const startedAt=new Date().toISOString();
server.listen(port,'127.0.0.1',()=>console.log(`CODEX TRACE — http://127.0.0.1:${port}/\nRead-only local viewer. Remote sync ${remoteSync?'enabled':'disabled'}. PID ${process.pid}`));
server.on('error',err=>{clearInterval(timer);console.error(err.code==='EADDRINUSE'?'Port occupied. Existing process was preserved.':err.message);process.exitCode=1;});
function shutdown(){clearInterval(timer);remoteSync?.stop();server.close(()=>{store.close();process.exit(0);});}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
