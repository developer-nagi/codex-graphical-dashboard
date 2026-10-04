import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import path from 'node:path';

export class TelemetryStore {
  constructor(filename){
    if(filename!==':memory:')mkdirSync(path.dirname(filename),{recursive:true});
    this.db=new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,file TEXT NOT NULL UNIQUE,parent_id TEXT,updated_at TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS sessions_parent ON sessions(parent_id);
      CREATE INDEX IF NOT EXISTS sessions_updated ON sessions(updated_at DESC);
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,time TEXT NOT NULL,type TEXT NOT NULL,status TEXT NOT NULL,evidence TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_task_time ON events(task_id,time DESC,id DESC);
      CREATE INDEX IF NOT EXISTS events_time ON events(time DESC,id DESC);
      CREATE INDEX IF NOT EXISTS events_call ON events(task_id,json_extract(data,'$.callId'));
      CREATE TABLE IF NOT EXISTS cursors(file TEXT PRIMARY KEY,offset INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_links(key TEXT PRIMARY KEY,event_id TEXT NOT NULL);`);
    if(this.db.prepare('PRAGMA user_version').get().user_version<2)this.db.exec('DELETE FROM cursors; PRAGMA user_version=2;');
    this.putTask=this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET file=excluded.file,parent_id=excluded.parent_id,updated_at=excluded.updated_at,data=excluded.data');
    this.putEvent=this.db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET time=excluded.time,status=excluded.status,evidence=excluded.evidence,data=excluded.data');
    this.putCursor=this.db.prepare('INSERT INTO cursors VALUES(?,?) ON CONFLICT(file) DO UPDATE SET offset=excluded.offset');
  }
  save(tasks,events,cursors,links=new Map()){
    this.db.exec('BEGIN IMMEDIATE');
    try{for(const [file,t]of tasks)this.putTask.run(t.id,file,t.parentId,t.updatedAt,JSON.stringify(t));
      for(const e of events)this.putEvent.run(e.id,e.taskId,e.time,e.type,e.status,e.evidence,JSON.stringify(e));
      for(const [file,c]of cursors)this.putCursor.run(file,Math.max(0,c.offset-(c.partial?.length||0)));
      this.db.exec('DELETE FROM runtime_links');const put=this.db.prepare('INSERT INTO runtime_links VALUES(?,?)');for(const [key,id]of links)put.run(key,id);
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  restore(){return {tasks:this.db.prepare('SELECT file,data FROM sessions ORDER BY updated_at DESC LIMIT 100').all().map(r=>[r.file,JSON.parse(r.data)]),events:this.db.prepare('SELECT data FROM events ORDER BY time DESC,id DESC LIMIT 6000').all().map(r=>JSON.parse(r.data)),cursors:this.db.prepare('SELECT file,offset FROM cursors').all().map(r=>[r.file,{offset:r.offset,partial:Buffer.alloc(0)}]),links:this.db.prepare('SELECT key,event_id FROM runtime_links').all().map(r=>[r.key,r.event_id])};}
  findCall(taskId,callId){const r=this.db.prepare("SELECT data FROM events WHERE task_id=? AND json_extract(data,'$.callId')=? ORDER BY time DESC LIMIT 1").get(taskId,callId);return r?JSON.parse(r.data):null;}
  findEvent(id){const r=this.db.prepare('SELECT data FROM events WHERE id=?').get(id);return r?JSON.parse(r.data):null;}
  findSource(file){const r=this.db.prepare('SELECT s.data,c.offset FROM sessions s LEFT JOIN cursors c ON s.file=c.file WHERE s.file=?').get(file);return r?{task:JSON.parse(r.data),offset:r.offset||0}:null;}
  position(file){return this.db.prepare('SELECT offset FROM cursors WHERE file=?').get(file)?.offset||0;}
  totals(){return {tasks:this.db.prepare('SELECT count(*) n FROM sessions').get().n,records:this.db.prepare('SELECT count(*) n FROM events').get().n,events:this.db.prepare("SELECT count(*) n FROM events WHERE type='tool' AND evidence!='script'").get().n,skills:this.db.prepare("SELECT count(*) n FROM events WHERE type='skill' AND evidence!='script'").get().n};}
  recentTasks(){return this.db.prepare('SELECT data FROM sessions ORDER BY updated_at DESC LIMIT 100').all().map(r=>JSON.parse(r.data));}
  history({taskId=null,before=null,beforeId='',limit=100}={}){
    limit=Math.max(1,Math.min(200,Number(limit)||100));
    const clause=before?' AND (time < ? OR (time = ? AND id < ?))':'';
    const values=before?[before,before,beforeId]:[];
    const rows=taskId?this.db.prepare(`WITH RECURSIVE family(id) AS (SELECT id FROM sessions WHERE id=? UNION SELECT s.id FROM sessions s JOIN family f ON s.parent_id=f.id) SELECT data,time,id FROM events WHERE task_id IN (SELECT id FROM family)${clause} ORDER BY time DESC,id DESC LIMIT ?`).all(taskId,...values,limit+1):this.db.prepare(`SELECT data,time,id FROM events WHERE 1=1${clause} ORDER BY time DESC,id DESC LIMIT ?`).all(...values,limit+1);
    const hasMore=rows.length>limit;const page=rows.slice(0,limit);const last=page.at(-1);
    return {events:page.map(r=>JSON.parse(r.data)),hasMore,cursor:hasMore?{time:last.time,id:last.id}:null};
  }
  close(){this.db.close();}
}
