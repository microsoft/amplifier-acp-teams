import { createHash } from "node:crypto";
import { ensure, type Config } from "./config.js";
import { Store, type Inbound, type Job } from "./store.js";
import { type OutputFile } from "./media.js";
import { AgentAuthenticationRequired, runTurn } from "./acp.js";

export function conversationKey(tenant: string, conversation: string) {
  return createHash("sha256")
    .update(JSON.stringify([tenant, conversation]))
    .digest("hex");
}
export function normalize(c: Config, a: any, ref: any): Inbound | undefined {
  if (
    a.type !== "message" ||
    a.channelId !== "msteams" ||
    a.recipient?.isTargeted === true
  )
    return;
  const tenant = a.channelData?.tenant?.id ?? a.conversation?.tenantId;
  if (
    tenant !== c.teams.tenant_id ||
    a.from?.role === "bot" ||
    a.from?.id === a.recipient?.id
  )
    return;
  const conversation = ref?.conversation?.id;
  if (
    typeof conversation !== "string" ||
    !conversation ||
    conversation.length > 1000 ||
    typeof a.id !== "string" ||
    a.id.length > 1000 ||
    typeof a.from?.id !== "string"
  )
    return;
  const kind = a.conversation?.conversationType;
  if (!["personal", "groupChat", "channel"].includes(kind)) return;
  const allowed =
    kind === "personal"
      ? c.teams.allow_personal
      : c.teams.conversations.includes(conversation.split(";messageid=")[0]!) ||
        c.teams.conversations.includes(conversation);
  if (!allowed) return;
  const service = new URL(ref.serviceUrl);
  ensure(
    service.protocol === "https:" &&
      !service.username &&
      !service.password &&
      service.port === "" &&
      ["smba.trafficmanager.net", "smba.infra.teams.microsoft.com"].includes(
        service.hostname,
      ),
    "Unrecognized Teams service endpoint",
  );
  const addressed = (a.entities ?? []).some(
    (v: any) =>
      v.type === "mention" &&
      [a.recipient?.id, c.teams.client_id, "28:" + c.teams.client_id].includes(
        v.mentioned?.id,
      ),
  );
  const text = String(a.text ?? "").slice(0, 40000);
  return {
    id: a.id,
    key: conversationKey(tenant, conversation),
    tenant,
    conversation,
    kind,
    service_url: service.toString(),
    bot_id: ref.bot?.id ?? a.recipient.id,
    sender: a.from.id,
    sender_name: String(a.from.name ?? a.from.id).slice(0, 200),
    text,
    addressed,
    attachments: (a.attachments ?? []).slice(0, 8).map((v: any) => ({
      name: String(v.name ?? "Attachment").slice(0, 200),
      content_type: String(v.contentType ?? "unknown").slice(0, 100),
    })),
    time: Number.isFinite(Date.parse(a.timestamp))
      ? Date.parse(a.timestamp)
      : Date.now(),
  };
}
export function allowed(c: Config, m: Inbound) {
  return (
    m.tenant === c.teams.tenant_id &&
    (m.kind === "personal"
      ? c.teams.allow_personal
      : c.teams.conversations.includes(m.conversation) ||
        c.teams.conversations.includes(m.conversation.split(";messageid=")[0]!))
  );
}
export type Deliver = (
  message: Inbound,
  text: string,
  files?: OutputFile[],
) => Promise<string>;
export class Runtime {
  active = new Map<
    string,
    { abort: AbortController; task: Promise<void>; message_id: string }
  >();
  stopped = false;
  timer: ReturnType<typeof setInterval>;
  constructor(
    readonly home: string,
    readonly store: Store,
    readonly config: () => Config,
    readonly deliver: Deliver,
    readonly turn = runTurn,
  ) {
    this.timer = setInterval(() => this.pump(), 250);
    this.timer.unref();
  }
  receive(a: any, ref: any) {
    const c = this.config();
    const m = normalize(c, a, ref);
    if (!m || !c.enabled) return false;
    return this.receiveMessage(m);
  }
  receiveMessage(m: Inbound, historical = false) {
    const c = this.config();
    if (!c.enabled || !allowed(c, m)) return false;
    this.store.bind(c);
    if (!historical) this.store.rememberRoute(m);
    const wake =
      m.kind === "personal" ||
      m.addressed ||
      c.teams.participation === "ambient";
    const accepted = this.store.ingest(
      m,
      !historical && wake,
      c.attention.max_pending,
    );
    this.pump();
    return accepted;
  }
  invalidateMessage(key: string, id: string) {
    this.store.db
      .prepare(
        "UPDATE jobs SET status='cancelled',note='Source message edited or deleted' WHERE key=? AND json_extract(message,'$.id')=? AND status='pending'",
      )
      .run(key, id);
    const current = this.active.get(key);
    if (current?.message_id === id) current.abort.abort();
  }
  pump() {
    if (this.stopped) return;
    const c = this.config();
    if (!c.enabled) return;
    while (this.active.size < c.attention.parallel_conversations) {
      const job = this.store.claim(new Set(this.active.keys()));
      if (!job) break;
      const abort = new AbortController();
      const task = this.run(job, abort.signal).finally(() =>
        this.active.delete(job.message.key),
      );
      this.active.set(job.message.key, {
        abort,
        task,
        message_id: job.message.id,
      });
    }
  }
  async run(job: Job, signal: AbortSignal) {
    const c = this.config();
    if (!allowed(c, job.message)) {
      this.store.finish(job.id, "cancelled", "Conversation access was removed");
      return;
    }
    const budget = this.store.db
      .prepare(
        "SELECT COUNT(*) AS count FROM jobs WHERE time>? AND status IN ('sent','sending','uncertain')",
      )
      .get(Date.now() - 3600000) as { count: number };
    if (budget.count >= c.attention.max_replies_per_hour) {
      this.store.finish(job.id, "limited", "Hourly reply budget reached");
      return;
    }
    try {
      const result = await this.turn(c, this.home, this.store, job, signal);
      if (
        signal.aborted ||
        !this.config().enabled ||
        !allowed(this.config(), job.message)
      ) {
        this.store.finish(
          job.id,
          "cancelled",
          "Connection paused or access removed",
        );
        this.store.forget(job.message.key);
        return;
      }
      if (result.pass) {
        this.store.finish(job.id, "pass", "Agent chose not to speak");
        return;
      }
      this.store.finish(job.id, "sending", "", result.text);
      try {
        const id = await this.deliver(job.message, result.text, result.files);
        this.store.delivered(job, result.text, id);
      } catch {
        this.store.finish(
          job.id,
          "uncertain",
          "Delivery did not receive a confirmation. Inspect Teams before retrying; work is not repeated.",
        );
      }
    } catch (error) {
      this.store.finish(
        job.id,
        signal.aborted ? "cancelled" : "failed",
        signal.aborted
          ? "Work stopped"
          : error instanceof AgentAuthenticationRequired
            ? error.message
            : "ACP work failed; no reply posted",
      );
      if (!(error instanceof AgentAuthenticationRequired))
        this.store.forget(job.message.key);
    }
  }
  async pause() {
    for (const a of this.active.values()) a.abort.abort();
    this.store.db.exec(
      "UPDATE jobs SET status='cancelled',note='Connection paused' WHERE status='pending';UPDATE permissions SET status='cancelled' WHERE status='pending';",
    );
    await Promise.allSettled([...this.active.values()].map((v) => v.task));
  }
  async close() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.pause();
  }
}
