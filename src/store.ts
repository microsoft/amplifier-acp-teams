import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { chmodSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import { ensure, privateDir } from "./config.js";

export interface Attachment {
  name: string;
  content_type: string;
  data?: string;
  note?: string;
}
export function projection(message: Inbound): Inbound {
  return {
    ...message,
    attachments: message.attachments.map(({ data, ...metadata }) => metadata),
  };
}
export interface Inbound {
  id: string;
  key: string;
  tenant: string;
  conversation: string;
  service_url: string;
  bot_id: string;
  kind: string;
  sender: string;
  sender_name: string;
  text: string;
  addressed: boolean;
  attachments: Attachment[];
  time: number;
}
export interface Job {
  id: string;
  message: Inbound;
  status: string;
  session_id: string | null;
  output: string | null;
  note: string;
}
export class Store {
  db: DatabaseSync;
  constructor(home: string) {
    privateDir(home);
    const path = join(home, "state.sqlite3");
    this.db = new DatabaseSync(path);
    if (process.platform !== "win32") chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS graph_state(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS routes(conversation TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS file_deliveries(id TEXT PRIMARY KEY,message TEXT NOT NULL,file TEXT NOT NULL,status TEXT NOT NULL,expires INTEGER NOT NULL,receipt TEXT);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(key TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,time INTEGER NOT NULL,PRIMARY KEY(key,id));
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,key TEXT NOT NULL,message TEXT NOT NULL,status TEXT NOT NULL,time INTEGER NOT NULL,session_id TEXT,output TEXT,note TEXT NOT NULL DEFAULT '',receipt TEXT);
      CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status,time);
      CREATE TABLE IF NOT EXISTS sessions(key TEXT PRIMARY KEY,endpoint TEXT NOT NULL,id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,time INTEGER NOT NULL,kind TEXT NOT NULL,detail TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS permissions(id TEXT PRIMARY KEY,job TEXT NOT NULL,request TEXT NOT NULL,expires INTEGER NOT NULL,decision TEXT,status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS views(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,state TEXT NOT NULL);
    `);
  }
  close() {
    this.db.close();
  }
  audit(kind: string, detail: unknown = {}) {
    this.db
      .prepare("INSERT INTO events(time,kind,detail) VALUES(?,?,?)")
      .run(Date.now(), kind, JSON.stringify(detail));
    this.db.exec(
      "DELETE FROM events WHERE seq < (SELECT COALESCE(MAX(seq),0)-5000 FROM events)",
    );
  }
  recover() {
    this.db.exec(
      "DELETE FROM sessions WHERE key IN (SELECT key FROM jobs WHERE status='running'); UPDATE jobs SET status='interrupted',note='Process stopped before completion; not replayed automatically' WHERE status IN ('running','pending'); UPDATE jobs SET status='uncertain',note='Process stopped during delivery; inspect Teams before retrying' WHERE status='sending'; UPDATE permissions SET status='cancelled' WHERE status='pending';",
    );
    this.db.exec(
      "UPDATE file_deliveries SET status='uncertain',file='{}' WHERE status='uploading'; UPDATE file_deliveries SET status='expired',file='{}' WHERE status='pending' AND expires < " +
        Date.now(),
    );
    this.audit("started");
  }
  bind(c: Config) {
    const identity = JSON.stringify([
      c.id,
      c.teams.client_id,
      c.teams.tenant_id,
      c.acp,
    ]);
    const prior = this.db
      .prepare("SELECT value FROM settings WHERE key='identity'")
      .get() as { value: string } | undefined;
    ensure(
      !prior || prior.value === identity,
      "This installation belongs to a different Teams identity or ACP endpoint; use a new folder",
    );
    this.db
      .prepare("INSERT OR IGNORE INTO settings VALUES('identity',?)")
      .run(identity);
  }
  ingest(message: Inbound, wake: boolean, maxPending: number) {
    if (
      this.db
        .prepare("SELECT 1 FROM messages WHERE key=? AND id=?")
        .get(message.key, message.id)
    )
      return false;
    this.db
      .prepare("INSERT INTO messages VALUES(?,?,?,?)")
      .run(message.key, message.id, JSON.stringify(message), message.time);
    if (!wake) return false;
    const count = this.db
      .prepare("SELECT COUNT(*) AS count FROM jobs WHERE status='pending'")
      .get() as { count: number };
    if (count.count >= maxPending) {
      this.audit("queue_full", { conversation: message.conversation });
      return false;
    }
    this.db
      .prepare(
        "INSERT INTO jobs(id,key,message,status,time) VALUES(?,?,?,'pending',?)",
      )
      .run(randomUUID(), message.key, JSON.stringify(message), Date.now());
    this.audit("queued", { conversation: message.conversation });
    return true;
  }
  rememberRoute(message: Inbound) {
    this.db
      .prepare(
        "INSERT INTO routes VALUES(?,?) ON CONFLICT(conversation) DO UPDATE SET body=excluded.body",
      )
      .run(
        message.conversation.split(";messageid=")[0]!,
        JSON.stringify({ ...projection(message), text: "", attachments: [] }),
      );
  }
  route(conversation: string): Inbound | undefined {
    const row = this.db
      .prepare("SELECT body FROM routes WHERE conversation=?")
      .get(conversation) as { body: string } | undefined;
    return row && JSON.parse(row.body);
  }
  graphState(key: string): any {
    const row = this.db
      .prepare("SELECT value FROM graph_state WHERE key=?")
      .get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : undefined;
  }
  setGraphState(key: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO graph_state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, JSON.stringify(value));
  }
  amend(message: Inbound) {
    // Edits and deletions update context without replaying model/tool work.
    this.db
      .prepare("UPDATE messages SET body=?,time=? WHERE key=? AND id=?")
      .run(JSON.stringify(message), message.time, message.key, message.id);
  }
  claim(active: Set<string>): Job | undefined {
    const rows = this.db
      .prepare(
        "SELECT * FROM jobs WHERE status='pending' ORDER BY time LIMIT 1000",
      )
      .all();
    for (const row of rows)
      if (!active.has(row.key as string)) {
        this.db
          .prepare("UPDATE jobs SET status='running' WHERE id=?")
          .run(row.id as string);
        return {
          ...row,
          message: JSON.parse(row.message as string),
        } as unknown as Job;
      }
  }
  history(key: string) {
    const rows = this.db
      .prepare(
        "SELECT body FROM messages WHERE key=? ORDER BY time DESC LIMIT 60",
      )
      .all(key);
    const result: Inbound[] = [];
    let size = 0;
    for (const row of rows) {
      const item = projection(JSON.parse(row.body as string));
      size += JSON.stringify(item).length;
      if (size > 60000) break;
      result.push(item);
    }
    return result.reverse();
  }
  receipts(key: string) {
    return this.db
      .prepare(
        "SELECT id,status,note,receipt FROM jobs WHERE key=? ORDER BY time DESC LIMIT 10",
      )
      .all(key);
  }
  finish(id: string, status: string, note = "", output?: string) {
    this.db
      .prepare(
        "UPDATE jobs SET status=?,note=?,output=COALESCE(?,output) WHERE id=?",
      )
      .run(status, note, output ?? null, id);
    this.audit(status, { job: id, note });
  }
  delivered(job: Job, text: string, id: string) {
    this.db
      .prepare("UPDATE jobs SET status='sent',receipt=? WHERE id=?")
      .run(id, job.id);
    const message = {
      ...job.message,
      id,
      sender: "agent",
      sender_name: "Connected agent",
      text,
      attachments: [],
      time: Date.now(),
    };
    this.db
      .prepare("INSERT OR IGNORE INTO messages VALUES(?,?,?,?)")
      .run(message.key, id, JSON.stringify(message), message.time);
    this.audit("sent", { job: job.id, conversation: job.message.conversation });
  }
  session(key: string, endpoint: string) {
    return (
      this.db
        .prepare("SELECT id FROM sessions WHERE key=? AND endpoint=?")
        .get(key, endpoint) as { id: string } | undefined
    )?.id;
  }
  bindSession(key: string, endpoint: string, id: string) {
    this.db
      .prepare(
        "INSERT INTO sessions VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET endpoint=excluded.endpoint,id=excluded.id",
      )
      .run(key, endpoint, id);
  }
  forget(key: string) {
    this.db.prepare("DELETE FROM sessions WHERE key=?").run(key);
  }
  status() {
    this.db
      .prepare(
        "UPDATE file_deliveries SET status='expired',file='{}' WHERE status='pending' AND expires < ?",
      )
      .run(Date.now());
    return {
      jobs: this.db
        .prepare("SELECT status,COUNT(*) AS count FROM jobs GROUP BY status")
        .all(),
      conversations: this.db
        .prepare(
          "SELECT key,MAX(time) AS last_activity,COUNT(*) AS messages FROM messages GROUP BY key ORDER BY last_activity DESC LIMIT 200",
        )
        .all(),
    };
  }
  activity(before = Number.MAX_SAFE_INTEGER) {
    return this.db
      .prepare("SELECT * FROM events WHERE seq < ? ORDER BY seq DESC LIMIT 100")
      .all(before)
      .map((v) => ({ ...v, detail: JSON.parse(v.detail as string) }));
  }
  pendingPermissions() {
    this.db
      .prepare(
        "UPDATE permissions SET status='expired' WHERE status='pending' AND expires < ?",
      )
      .run(Date.now());
    return this.db
      .prepare("SELECT * FROM permissions ORDER BY expires DESC LIMIT 100")
      .all()
      .map((v) => ({ ...v, request: JSON.parse(v.request as string) }));
  }
  decision(id: string, option: string | null) {
    const row = this.db
      .prepare(
        "SELECT request,expires FROM permissions WHERE id=? AND status='pending'",
      )
      .get(id) as { request: string; expires: number } | undefined;
    ensure(
      row && row.expires > Date.now(),
      "Permission request is no longer pending",
    );
    const request = JSON.parse(row.request);
    ensure(
      option === null ||
        request.options.some(
          (v: any) =>
            v.optionId === option &&
            ["allow_once", "reject_once"].includes(v.kind),
        ),
      "Choose one of the offered single-use options",
    );
    this.db
      .prepare("UPDATE permissions SET status='decided',decision=? WHERE id=?")
      .run(JSON.stringify(option), id);
    this.audit("permission_decided", { id });
  }
}
