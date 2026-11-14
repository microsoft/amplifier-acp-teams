import { ensure, type Config } from "./config.js";
import { sourceRevision, type Store, type Inbound, type Job } from "./store.js";
import { allowed } from "./runtime.js";
export const SOURCE_META = "com.microsoft.amplifier.source-delivery";
export const SOURCE_METHOD = "_amplifier/source_receipts";

export function sourceReference(m: Inbound) {
  return {
    tenant: m.tenant,
    conversation: m.conversation,
    id: m.id,
    revision: sourceRevision(m),
    sender: m.sender,
  };
}
export function inspectSubmissions(store: Store, c: Config, request: any) {
  ensure(
    request &&
      Object.keys(request).every((k) => k === "sources") &&
      Array.isArray(request.sources) &&
      request.sources.length > 0 &&
      request.sources.length <= 16,
    "Expected 1–16 exact source references",
  );
  const keys = ["tenant", "conversation", "id", "revision", "sender"];
  const items = request.sources.map((source: any) => {
    ensure(
      source &&
        Object.keys(source).length === keys.length &&
        keys.every(
          (k) =>
            typeof source[k] === "string" &&
            source[k].length > 0 &&
            source[k].length <= 1024,
        ),
      "Invalid exact source reference",
    );
    const rows = store.db
      .prepare(
        "SELECT id,message,status,time,receipt,source_delivery FROM jobs WHERE json_extract(message,'$.tenant')=? AND json_extract(message,'$.conversation')=? AND json_extract(message,'$.id')=? AND json_extract(message,'$.sender')=? ORDER BY time,rowid LIMIT 65",
      )
      .all(source.tenant, source.conversation, source.id, source.sender);
    const attempts = [];
    for (const row of rows) {
      const m = JSON.parse(row.message as string) as Inbound;
      if (!allowed(c, m) || sourceRevision(m) !== source.revision) continue;
      attempts.push({
        job_id: row.id,
        processing: { state: row.status, created_at: row.time },
        publication: {
          state:
            row.status === "sent"
              ? "sent"
              : row.status === "uncertain"
                ? "uncertain"
                : row.status === "sending"
                  ? "sending"
                  : "unknown",
          message_id: row.receipt,
        },
        instance: row.source_delivery
          ? JSON.parse(row.source_delivery as string)
          : { state: "unknown", work: [], coverage: "not_observed" },
      });
    }
    return {
      source,
      state: attempts.length ? "retained" : "unknown",
      attempts: attempts.slice(0, 64),
      coverage:
        attempts.length === 0
          ? "not_retained_or_not_authorized"
          : rows.length > 64
            ? "partial"
            : "retained_exact_source_records",
      completion: "not_established",
    };
  });
  return {
    version: 1,
    items,
    observed_at: Date.now(),
    missing: "unknown",
    inspection: "local_records_only",
  };
}
export function sourceProfile(init: any) {
  const p =
    init?._meta?.["io.github.bkrabach.agent-instance"]?.inputContinuity
      ?.sourceDelivery;
  return (
    p?.version === 1 &&
    p.metadata === SOURCE_META &&
    p.ordinaryPrompts === true &&
    p.workReferences === true &&
    p.receiptsMethod === SOURCE_METHOD
  );
}
function save(store: Store, job: Job, value: unknown) {
  store.db
    .prepare("UPDATE jobs SET source_delivery=? WHERE id=?")
    .run(JSON.stringify(value), job.id);
}
export function prepareSource(
  store: Store,
  c: Config,
  job: Job,
  init: any,
  session: string,
  endpoint: string,
) {
  if (!sourceProfile(init)) {
    save(store, job, {
      state: "unsupported",
      work: [],
      coverage: "not_advertised",
    });
    return undefined;
  }
  const m = job.message,
    revision = sourceRevision(m);
  if (
    m.id.length > 512 ||
    revision.length > 128 ||
    !Number.isSafeInteger(m.time) ||
    m.time <= 0 ||
    m.time > Date.now() + 5000
  ) {
    save(store, job, {
      state: "unsupported",
      work: [],
      coverage: "source_outside_profile",
    });
    return undefined;
  }
  const metadata = {
    version: 1,
    inputId: job.id,
    sources: [{ id: m.id, revision, occurredAt: m.time }],
  };
  save(store, job, {
    state: "unknown",
    session_id: session,
    endpoint,
    input_id: job.id,
    receipt_query: {
      method: SOURCE_METHOD,
      params: { sessionId: session, sources: metadata.sources },
    },
    work: [],
    coverage: "not_observed",
    audience_binding: c.context.enabled ? "configured_grant" : "unavailable",
    observed_at: Date.now(),
  });
  return metadata;
}
export function recordSource(
  store: Store,
  c: Config,
  job: Job,
  metadata: any,
  session: string,
  endpoint: string,
  result: any,
) {
  const s = metadata.sources[0];
  const receipt =
    result?.version === 1 && Array.isArray(result.receipts)
      ? result.receipts.find(
          (r: any) =>
            r.sourceId === s.id &&
            r.revision === s.revision &&
            r.occurredAt === s.occurredAt,
        )
      : undefined;
  save(store, job, {
    state: receipt ? "observed" : "unknown",
    session_id: session,
    endpoint,
    input_id: job.id,
    receipt_query: {
      method: SOURCE_METHOD,
      params: { sessionId: session, sources: metadata.sources },
    },
    receipt,
    work: receipt?.work ?? [],
    coverage: receipt ? result.coverage : "missing_or_unavailable",
    audience_binding: c.context.enabled ? "configured_grant" : "unavailable",
    observed_at: Date.now(),
    current_state: "not_refreshed",
  });
}
