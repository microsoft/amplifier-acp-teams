/** Optional existing Instance conversation profile, served by this installation. */
import { createHash, randomBytes } from "node:crypto";
import { ensure, type Config } from "./config.js";
import type { Store, Job, Inbound } from "./store.js";
import { allowed } from "./runtime.js";
import { sourceReference } from "./submissions.js";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const identity = (c: Config) =>
  JSON.stringify([c.id, c.revision, c.teams.tenant_id, c.teams.client_id]);
export function issueContextGrant(store: Store, c: Config, job: Job) {
  ensure(
    c.context.enabled && allowed(c, job.message),
    "Conversation context is not enabled for this source",
  );
  const row = store.db
    .prepare("SELECT message FROM jobs WHERE id=?")
    .get(job.id);
  ensure(
    row &&
      JSON.stringify(sourceReference(JSON.parse(row.message as string))) ===
        JSON.stringify(sourceReference(job.message)),
    "Source does not match retained job",
  );
  const token = randomBytes(32).toString("hex");
  const value = {
    hash: hash(token),
    identity: identity(c),
    source: sourceReference(job.message),
    expires: Date.now() + 30 * 60 * 1000,
  };
  store.db
    .prepare("UPDATE jobs SET context_grant=? WHERE id=?")
    .run(JSON.stringify(value), job.id);
  return { provider_id: `teams:${c.id}`, grant: token };
}
export function contextQuery(store: Store, c: Config, request: any) {
  ensure(
    c.context.enabled &&
      request &&
      ["authorize", "orientation", "read"].includes(request.operation),
    "Conversation context is unavailable",
  );
  ensure(
    Object.keys(request).every((k) =>
      ["operation", "access", "conversation_id", "thread_id", "limit"].includes(
        k,
      ),
    ),
    "Unsupported context request",
  );
  ensure(
    request.access?.mode === "grant" &&
      Object.keys(request.access).every((k) => ["mode", "grant"].includes(k)) &&
      typeof request.access.grant === "string" &&
      /^[a-f0-9]{64}$/.test(request.access.grant),
    "A source grant is required",
  );
  const row = store.db
    .prepare(
      "SELECT message,context_grant FROM jobs WHERE json_extract(context_grant,'$.hash')=?",
    )
    .get(hash(request.access.grant));
  ensure(row, "Unknown source grant");
  const grant = JSON.parse(row.context_grant as string),
    m = JSON.parse(row.message as string) as Inbound;
  ensure(
    grant.identity === identity(c) &&
      grant.expires > Date.now() &&
      allowed(c, m) &&
      JSON.stringify(grant.source) === JSON.stringify(sourceReference(m)),
    "Source grant is expired or revoked",
  );
  ensure(
    (request.conversation_id === undefined ||
      request.conversation_id === m.conversation) &&
      (request.thread_id === undefined || request.thread_id === ""),
    "Source grant belongs to another conversation",
  );
  const binding = {
    owner: false,
    conversation_id: m.conversation,
    actor_id: m.sender,
    thread_id: "",
    surface: "teams",
    label: "Microsoft Teams conversation",
    observed_at: Date.now(),
    authorization: "retained_source_and_current_configured_scope",
  };
  if (request.operation === "authorize") return binding;
  const limit = request.limit ?? 12;
  ensure(
    Number.isInteger(limit) && limit >= 1 && limit <= 40,
    "Expected 1–40 messages",
  );
  const messages = store
    .history(m.key)
    .slice(-limit)
    .map((item) => ({
      id: item.id,
      revision: sourceReference(item).revision,
      sender: item.sender,
      text: item.text,
      occurred_at: item.time,
    }));
  return {
    ...binding,
    messages,
    complete: false,
    coverage: "bounded_retained_connector_messages",
    source: "Microsoft Teams",
    next_cursor: null,
  };
}
