import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  ensure,
  readPrivate,
  type Config,
  type GraphTarget,
} from "./config.js";
import { Runtime, allowed, conversationKey } from "./runtime.js";
import { Store, type Inbound } from "./store.js";

export const GRAPH = "https://graph.microsoft.com/v1.0";
export type Fetch = typeof fetch;
export function resourcePath(target: GraphTarget) {
  const e = encodeURIComponent;
  return target.kind === "chat"
    ? `/chats/${e(target.chat_id!)}/messages`
    : `/teams/${e(target.team_id!)}/channels/${e(target.channel_id!)}/messages`;
}
export async function boundedBody(response: Response, limit: number) {
  ensure(response.body, "Empty response");
  const declared = Number(response.headers.get("content-length"));
  ensure(
    !declared || declared <= limit,
    "Response exceeds configured size limit",
  );
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      ensure(size <= limit, "Response exceeds configured size limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}
export class GraphClient {
  signal?: AbortSignal;
  token?: { value: string; expires: number; identity: string };
  constructor(
    readonly home: string,
    readonly config: () => Config,
    readonly fetcher: Fetch = fetch,
  ) {}
  async accessToken() {
    const c = this.config();
    const identity = c.teams.tenant_id + ":" + c.teams.client_id;
    if (
      this.token?.identity === identity &&
      this.token.expires > Date.now() + 60000
    )
      return this.token.value;
    ensure(
      c.teams.tenant_id && c.teams.client_id,
      "Configure the Teams application first",
    );
    const response = await this.fetcher(
      `https://login.microsoftonline.com/${c.teams.tenant_id}/oauth2/v2.0/token`,
      {
        method: "POST",
        redirect: "error",
        signal: this.signal
          ? AbortSignal.any([this.signal, AbortSignal.timeout(15000)])
          : AbortSignal.timeout(15000),
        body: new URLSearchParams({
          client_id: c.teams.client_id,
          client_secret: readPrivate(
            join(this.home, "secrets", "client-secret"),
          ),
          grant_type: "client_credentials",
          scope: "https://graph.microsoft.com/.default",
        }),
      },
    );
    ensure(response.ok, "Graph credential exchange failed");
    const value = JSON.parse(
      (await boundedBody(response, 128000)).toString("utf8"),
    );
    ensure(
      typeof value.access_token === "string" && value.access_token.length > 0,
      "Graph returned no access token",
    );
    this.token = {
      value: value.access_token,
      identity,
      expires:
        Date.now() + Math.min(Number(value.expires_in) || 300, 3600) * 1000,
    };
    return this.token.value;
  }
  async response(path: string, limit = 1024 * 1024) {
    // Constructed Graph resource paths only. Never follow a nextLink/redirect to
    // another resource or send this token to a media CDN or model process.
    ensure(
      path.startsWith("/") && !path.startsWith("//") && !/[\\\r\n#]/.test(path),
      "Invalid Graph resource path",
    );
    const token = await this.accessToken();
    const response = await this.fetcher(GRAPH + path, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: this.signal
        ? AbortSignal.any([this.signal, AbortSignal.timeout(15000)])
        : AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const error = new Error(
        response.status === 403
          ? "Graph consent is missing for this conversation"
          : response.status === 429
            ? "Graph rate limited this connection"
            : "Graph request failed",
      ) as Error & { status: number; retryAfter: number };
      error.status = response.status;
      error.retryAfter = Math.min(
        3600,
        Math.max(15, Number(response.headers.get("retry-after")) || 60),
      );
      if (response.status === 401) this.token = undefined;
      throw error;
    }
    return {
      bytes: await boundedBody(response, limit),
      mime:
        response.headers.get("content-type")?.split(";")[0] ??
        "application/octet-stream",
    };
  }
  async json(path: string) {
    return JSON.parse((await this.response(path)).bytes.toString("utf8"));
  }
  async collection(
    path: string,
    pages = 4,
  ): Promise<{ items: any[]; truncated: boolean }> {
    let next = path;
    const items: any[] = [];
    const seen = new Set<string>();
    const expectedPath = new URL(GRAPH + path).pathname;
    for (let i = 0; next && i < pages; i++) {
      ensure(!seen.has(next), "Graph pagination repeated");
      seen.add(next);
      const data = await this.json(next);
      ensure(
        Array.isArray(data.value) && data.value.length <= 500,
        "Unexpected Graph collection",
      );
      items.push(...data.value);
      next = "";
      if (data["@odata.nextLink"]) {
        const u = new URL(data["@odata.nextLink"]);
        ensure(
          u.origin === "https://graph.microsoft.com" &&
            u.pathname === expectedPath &&
            !u.username &&
            !u.password &&
            !u.hash,
          "Graph pagination changed the authorized resource",
        );
        next = u.pathname.slice("/v1.0".length) + u.search;
      }
    }
    return { items, truncated: !!next };
  }
}
export function plainText(value: string) {
  return value
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?\s*>|<\/(p|div|li)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(
      /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
      (all, name: string) => {
        const v = name.toLowerCase();
        if (v.startsWith("#")) {
          const n = parseInt(
            v.startsWith("#x") ? v.slice(2) : v.slice(1),
            v.startsWith("#x") ? 16 : 10,
          );
          return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff)
            ? String.fromCodePoint(n)
            : "";
        }
        return (
          (
            {
              amp: "&",
              lt: "<",
              gt: ">",
              quot: '"',
              apos: "'",
              nbsp: " ",
            } as Record<string, string>
          )[v] ?? all
        );
      },
    )
    .trim()
    .slice(0, 40000);
}
export function graphMessage(
  c: Config,
  t: GraphTarget,
  route: Inbound,
  raw: any,
  parent?: string,
  prior?: Inbound,
): Inbound | undefined {
  if (
    !raw ||
    typeof raw.id !== "string" ||
    !raw.id ||
    raw.id.length > 1000 ||
    !/^[A-Za-z0-9_-]+$/.test(raw.id) ||
    (raw.messageType && raw.messageType !== "message")
  )
    return;
  if (
    raw.channelIdentity &&
    (raw.channelIdentity.teamId !== t.team_id ||
      raw.channelIdentity.channelId !== t.channel_id)
  )
    return;
  if (raw.chatId && raw.chatId !== t.chat_id) return;
  if (parent && raw.replyToId && raw.replyToId !== parent) return;
  const conversation =
    t.kind === "channel"
      ? `${t.conversation_id};messageid=${parent ?? raw.id}`
      : t.conversation_id;
  // Deleted Graph messages can omit the author and creation timestamp. Only
  // use our already-recorded message in this exact tenant/room/id to tombstone.
  const deletedPrior =
    raw.deletedDateTime &&
    prior &&
    prior.id === raw.id &&
    prior.conversation === conversation &&
    prior.tenant === c.teams.tenant_id
      ? prior
      : undefined;
  const author =
    raw.from?.user ??
    raw.from?.application ??
    (deletedPrior
      ? { id: deletedPrior.sender, displayName: deletedPrior.sender_name }
      : undefined);
  if (!author?.id || (author.tenantId && author.tenantId !== c.teams.tenant_id))
    return;
  if (
    raw.from?.application &&
    (author.id === c.teams.client_id || !c.graph.include_bots)
  )
    return;
  const time = deletedPrior?.time ?? Date.parse(raw.createdDateTime);
  if (!Number.isFinite(time)) return;
  return {
    ...route,
    id: raw.id,
    conversation,
    key: conversationKey(c.teams.tenant_id, conversation),
    sender: author.id,
    sender_name: String(author.displayName ?? author.id).slice(0, 200),
    text: raw.deletedDateTime
      ? "[Message deleted in Teams]"
      : raw.body?.contentType === "html"
        ? plainText(String(raw.body?.content ?? ""))
        : String(raw.body?.content ?? "").slice(0, 40000),
    addressed: (raw.mentions ?? []).some(
      (m: any) =>
        m.mentioned?.application?.id === c.teams.client_id ||
        m.mentioned?.user?.id === route.bot_id,
    ),
    attachments: (raw.attachments ?? []).slice(0, 8).map((a: any) => ({
      name: String(a.name ?? "Attachment").slice(0, 200),
      content_type: String(a.contentType ?? "unknown").slice(0, 100),
      note: "File reference only; SharePoint file access is not granted by Teams message consent",
    })),
    time,
  };
}
export class GraphPoller {
  busy = false;
  stopped = false;
  controller?: AbortController;
  timer: ReturnType<typeof setInterval>;
  constructor(
    readonly client: GraphClient,
    readonly store: Store,
    readonly engine: Runtime,
    readonly config: () => Config,
    readonly enrich?: (
      message: Inbound,
      path: string,
      raw: any,
    ) => Promise<Inbound>,
  ) {
    this.timer = setInterval(() => {
      void this.poll();
    }, 1000);
    this.timer.unref();
  }
  async poll(force = false) {
    const c = this.config();
    if (this.stopped || this.busy || !c.enabled || !c.graph.enabled) return;
    this.busy = true;
    try {
      for (const target of c.graph.targets) {
        if (this.stopped || !this.config().enabled) break;
        const key = createHash("sha256")
          .update(JSON.stringify([c.teams.tenant_id, target]))
          .digest("hex");
        const previous = this.store.graphState(key);
        if (!force && previous?.next_at > Date.now()) continue;
        const route = this.store.route(target.conversation_id);
        if (!route || !allowed(c, route)) {
          this.store.setGraphState(key, {
            ...previous,
            conversation: target.conversation_id,
            state: "waiting_for_verified_conversation",
            next_at: Date.now() + c.graph.poll_seconds * 1000,
          });
          continue;
        }
        const started = Date.now();
        const first = !previous?.initialized;
        this.controller = new AbortController();
        this.client.signal = this.controller.signal;
        const deadline = setTimeout(() => this.controller?.abort(), 60000);
        try {
          const base = resourcePath(target);
          const roots = await this.client.collection(
            base +
              (target.kind === "chat"
                ? "?$top=50&$orderby=lastModifiedDateTime%20desc"
                : "?$top=20"),
            target.kind === "chat" ? 4 : 1,
          );
          const all: { raw: any; parent?: string; path: string }[] = [];
          let truncated = roots.truncated;
          for (const raw of roots.items) {
            if (typeof raw.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(raw.id))
              continue;
            const path = base + "/" + encodeURIComponent(raw.id);
            all.push({ raw, path });
            if (target.kind === "channel") {
              const replies = await this.client.collection(
                path + "/replies?$top=50",
                2,
              );
              truncated ||= replies.truncated;
              for (const r of replies.items)
                all.push({
                  raw: r,
                  parent: raw.id,
                  path: path + "/replies/" + encodeURIComponent(r.id ?? ""),
                });
            }
          }
          all.sort(
            (a, b) =>
              Date.parse(a.raw.createdDateTime) -
              Date.parse(b.raw.createdDateTime),
          );
          let queued = 0;
          for (const item of all) {
            if (
              this.stopped ||
              !this.config().enabled ||
              !this.config().graph.targets.some(
                (t) => JSON.stringify(t) === JSON.stringify(target),
              )
            )
              break;
            const conversation =
              target.kind === "channel"
                ? `${target.conversation_id};messageid=${item.parent ?? item.raw.id}`
                : target.conversation_id;
            const prior = this.store.db
              .prepare("SELECT body FROM messages WHERE key=? AND id=?")
              .get(
                conversationKey(c.teams.tenant_id, conversation),
                String(item.raw.id ?? ""),
              ) as { body: string } | undefined;
            let message = graphMessage(
              c,
              target,
              route,
              item.raw,
              item.parent,
              prior ? JSON.parse(prior.body) : undefined,
            );
            if (!message || !allowed(this.config(), message)) continue;
            if (prior) {
              this.store.amend(message);
              if (item.raw.lastEditedDateTime || item.raw.deletedDateTime)
                this.engine.invalidateMessage?.(message.key, message.id);
              continue;
            }
            // Initial sync is context only. Restart resumes durable seen IDs; no
            // message older than initial activation can launch model/tool work.
            const historical =
              first ||
              message.time <= (previous?.activated_at ?? started) ||
              !!item.raw.deletedDateTime;
            if (!historical && this.enrich)
              message = await this.enrich(message, item.path, item.raw);
            if (this.engine.receiveMessage(message, historical)) queued++;
          }
          this.store.setGraphState(key, {
            initialized: true,
            activated_at: previous?.activated_at ?? started,
            conversation: target.conversation_id,
            state: "ready",
            last_sync: Date.now(),
            next_at: Date.now() + c.graph.poll_seconds * 1000,
            messages: all.length,
            queued,
            truncated,
          });
          this.store.audit("graph_sync", {
            conversation: target.conversation_id,
            messages: all.length,
            queued,
            truncated,
            baseline: first,
          });
        } catch (error: any) {
          this.store.setGraphState(key, {
            ...previous,
            conversation: target.conversation_id,
            state:
              error.status === 403
                ? "consent_required"
                : error.status === 429
                  ? "rate_limited"
                  : "error",
            next_at:
              Date.now() + (error.retryAfter ?? c.graph.poll_seconds) * 1000,
          });
          this.store.audit("graph_sync_failed", {
            conversation: target.conversation_id,
            status: error.status ?? null,
            note: "No credential, source URL, or private response body was recorded",
          });
        } finally {
          clearTimeout(deadline);
          this.client.signal = undefined;
        }
      }
    } finally {
      this.busy = false;
    }
  }
  status() {
    return this.store.db
      .prepare("SELECT value FROM graph_state")
      .all()
      .map((r: any) => JSON.parse(r.value));
  }
  async close() {
    this.stopped = true;
    clearInterval(this.timer);
    this.controller?.abort();
    while (this.busy) await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
