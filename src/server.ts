import { App } from "@microsoft/teams.apps";
import { PUBLIC } from "@microsoft/teams.api";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensure, load, ready, readPrivate, save, validate } from "./config.js";
import { Store } from "./store.js";
import { GraphClient, GraphPoller } from "./graph.js";
import {
  hydrateActivity,
  hydrateGraph,
  prepareDelivery,
  fileConsent,
} from "./media.js";
import { Runtime, normalize } from "./runtime.js";
import { body, json, Transport } from "./transport.js";
import { AgentAuthenticationRequired, check } from "./acp.js";
import { manifest } from "./manifest.js";
import { dashboard } from "./ui.js";
import { matchingUpdate, updateHeld, updateIdle } from "./native_update.js";
import { NativeAuth, nativeSettings } from "./native.js";

function authenticate(received: string | undefined, expected: string) {
  const value = received?.startsWith("Bearer ") ? received.slice(7) : "";
  return timingSafeEqual(
    createHash("sha256").update(value).digest(),
    createHash("sha256").update(expected).digest(),
  );
}
export function lock(home: string) {
  const path = join(home, "process.lock");
  if (existsSync(path)) {
    const pid = Number(readFileSync(path, "utf8"));
    ensure(
      Number.isSafeInteger(pid) && pid > 0,
      "Invalid process lock; inspect it before starting",
    );
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (e: any) {
      if (e.code === "ESRCH") alive = false;
    }
    ensure(!alive, "This connection already has a running process");
    unlinkSync(path);
  }
  writeFileSync(path, String(process.pid), { flag: "wx", mode: 0o600 });
  return () => unlinkSync(path);
}
export async function serve(home: string) {
  let config = load(home);
  const token = readPrivate(join(home, "secrets", "control-token"));
  const release = lock(home);
  const startup = JSON.stringify([
    config.server,
    config.teams.client_id,
    config.teams.tenant_id,
  ]);
  const store = new Store(home);
  store.recover();
  const native = new NativeAuth(home, config, store, token);
  let app: App | undefined;
  let engine: Runtime;
  let authReady = false;
  const graph = new GraphClient(home, () => config);
  let poller: GraphPoller;
  let closeForUpdate: (() => Promise<void>) | undefined;
  function hold(value: boolean) {
    transport.updateHold = value;
    engine.stopped = value;
    poller.stopped = value;
  }
  function idle() {
    const pending = store.db
      .prepare(
        "SELECT COUNT(*) AS n FROM jobs WHERE status IN ('pending','running','sending')",
      )
      .get() as { n: number };
    const files = store.db
      .prepare(
        "SELECT COUNT(*) AS n FROM file_deliveries WHERE status='uploading'",
      )
      .get() as { n: number };
    return updateIdle(
      engine.active.size,
      poller.busy,
      transport.activeMutations,
      pending.n + files.n,
    );
  }
  const sdkLog: any = {
    debug() {},
    trace() {},
    info() {},
    warn() {},
    error() {
      store.audit("teams_sdk_error", {
        note: "Teams request failed; no private SDK payload was logged",
      });
    },
    log() {},
    child() {
      return this;
    },
  };
  const transport = new Transport(config.server.bind, async (req, res) => {
    const url = new URL(req.url ?? "/", "http://local"),
      path = url.pathname;
    if (
      !["/healthz", "/about", "/privacy", "/terms"].includes(path) &&
      !native.allowed(req)
    ) {
      json(res, 403, { error: "Use the saved local connector address" });
      return;
    }
    if (await native.route(req, res, url)) return;
    if (req.method === "GET" && path === "/") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy":
          "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
      });
      const name = config.label
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
      res.end(
        dashboard.replace(
          "<title>Teams connection</title>",
          `<title>${name}: Teams Connector</title>`,
        ),
      );
      return;
    }
    if (
      req.method === "GET" &&
      ["/healthz", "/about", "/privacy", "/terms"].includes(path)
    ) {
      json(
        res,
        200,
        path === "/healthz"
          ? { ok: true }
          : {
              message:
                "This independently operated connector stores the messages its bot receives in its private installation folder and forwards their bounded context to the configured ACP agent. Contact this installation’s operator for access and retention. It has no workspace-wide history access.",
            },
      );
      return;
    }
    if (
      !authenticate(req.headers.authorization, token) &&
      !native.authorize(req)
    ) {
      json(res, 401, { error: "Supply the connector management token" });
      return;
    }
    // Browser calls stay same-origin. No ambient credentials or token-in-URL path.
    if (req.headers.origin) {
      const origin = new URL(req.headers.origin);
      const local = `http://${req.headers.host}`;
      ensure(
        origin.origin === config.server.public_url || origin.origin === local,
        "Unexpected browser origin",
      );
    }
    if (path === "/api/v1/descriptor" && req.method === "GET") {
      json(res, 200, {
        kind: "acp-teams-adapter",
        version: "0.5.1",
        id: config.id,
        api: "/api/v1",
        protocol: "ACP 1 over stdio",
        operations: [
          "config",
          "status",
          "activity",
          "conversations",
          "history",
          "permissions",
          "lifecycle",
          "check",
          "manifest",
          "graph/status",
          "graph/sync",
          "views",
        ],
        teams_endpoint: "/api/messages",
        authentication:
          "Bearer management token; Teams messages use the Microsoft SDK JWT validator",
      });
      return;
    }
    if (path === "/api/v1/config") {
      if (req.method === "GET") {
        json(res, 200, config);
        return;
      }
      if (req.method === "PUT") {
        ensure(!config.enabled, "Pause the connection before editing");
        const value = validate(await body(req));
        nativeSettings(home, value);
        ensure(
          value.revision === config.revision,
          "Configuration changed; reload before saving",
        );
        ensure(
          value.id === config.id && !value.enabled,
          "Use lifecycle to enable; connection identity cannot change",
        );
        const binding = store.db
          .prepare("SELECT value FROM settings WHERE key='identity'")
          .get() as { value: string } | undefined;
        if (binding)
          ensure(
            binding.value ===
              JSON.stringify([
                value.id,
                value.teams.client_id,
                value.teams.tenant_id,
                value.acp,
              ]),
            "Use a new installation for a different Teams identity or ACP agent",
          );
        value.revision++;
        save(home, value);
        config = value;
        json(res, 200, {
          config,
          restart_required:
            startup !==
            JSON.stringify([
              config.server,
              config.teams.client_id,
              config.teams.tenant_id,
            ]),
        });
        return;
      }
    }
    if (path.startsWith("/api/v1/native-update/") && native.settings) {
      if (req.method === "GET" && path.endsWith("/readiness")) {
        json(res, 200, { id: config.id, idle: idle() });
        return;
      }
      if (req.method === "POST" && path.endsWith("/stop")) {
        matchingUpdate(home, config.id, await body(req, 1024), [
          "stopping",
          "rolling_back",
        ]);
        // All checks and the admission hold happen synchronously before yielding.
        if (!idle()) {
          json(res, 200, { id: config.id, accepted: false, reason: "busy" });
          return;
        }
        ensure(closeForUpdate, "Native shutdown is unavailable");
        hold(true);
        json(res, 200, { id: config.id, accepted: true });
        setTimeout(
          () => void closeForUpdate!().then(() => process.exit(0)),
          150,
        ).unref();
        return;
      }
      if (req.method === "POST" && path.endsWith("/finish")) {
        matchingUpdate(home, config.id, await body(req, 1024), [
          "applied",
          "rolled_back",
        ]);
        hold(false);
        json(res, 200, { id: config.id, ready: true });
        return;
      }
    }
    if (path === "/api/v1/startup" && native.settings) {
      if (req.method === "GET") {
        json(
          res,
          200,
          existsSync(join(home, "startup.json"))
            ? JSON.parse(readFileSync(join(home, "startup.json"), "utf8"))
            : { configured: false },
        );
        return;
      }
      if (req.method === "POST") {
        const v = await body(req, 1024);
        ensure(
          Object.keys(v).length === 1 && typeof v.enabled === "boolean",
          "Choose startup on or off",
        );
        await native.startup(v.enabled);
        json(res, 200, { configured: v.enabled });
        return;
      }
    }
    if (path === "/api/v1/status" && req.method === "GET") {
      json(res, 200, {
        id: config.id,
        version: "0.5.1",
        pid: process.pid,
        launcher_pid: Number(process.env.ACP_TEAMS_LAUNCHER_PID) || null,
        label: config.label,
        enabled: config.enabled,
        teams_configured: authReady,
        active: engine.active.size,
        graph: { enabled: config.graph.enabled, targets: poller.status() },
        media: {
          ...config.media,
          pending_files: store.db
            .prepare(
              "SELECT COUNT(*) AS count FROM file_deliveries WHERE status='pending' AND expires>?",
            )
            .get(Date.now()),
        },
        ...store.status(),
        limitations: [
          "Graph history is bounded to explicitly configured conversations; first sync never launches agent work.",
          "Large outgoing files use personal-chat consent; group file destinations require separate configuration and grants.",
          "Permission decisions require the connector dashboard/API.",
          "Only commercial single-tenant Teams registrations are supported.",
        ],
      });
      return;
    }
    if (path === "/api/v1/graph/status" && req.method === "GET") {
      json(res, 200, {
        enabled: config.graph.enabled,
        targets: poller.status(),
      });
      return;
    }
    if (path === "/api/v1/graph/sync" && req.method === "POST") {
      ensure(
        config.enabled && config.graph.enabled,
        "Enable this connection and Graph ingestion first",
      );
      await poller.poll(true);
      json(res, 200, {
        targets: poller.status(),
        note: "Existing history is context only on initial sync. Later newly observed messages may trigger ordinary ACP work.",
      });
      return;
    }
    if (path === "/api/v1/activity" && req.method === "GET") {
      const before = Number(
        url.searchParams.get("before") ?? Number.MAX_SAFE_INTEGER,
      );
      ensure(
        Number.isSafeInteger(before) && before > 0,
        "Invalid activity cursor",
      );
      const items = store.activity(before);
      json(res, 200, {
        items,
        next_before:
          (items.at(-1) as Record<string, unknown> | undefined)?.seq ?? null,
      });
      return;
    }
    if (path === "/api/v1/conversations" && req.method === "GET") {
      json(res, 200, { items: store.status().conversations });
      return;
    }
    if (path === "/api/v1/history" && req.method === "GET") {
      const key = url.searchParams.get("key") ?? "";
      ensure(/^[a-f0-9]{64}$/.test(key), "Invalid conversation key");
      json(res, 200, { items: store.history(key), bounded: true });
      return;
    }
    if (path === "/api/v1/questions" && req.method === "GET") {
      json(res, 200, { items: store.questions.list() });
      return;
    }
    const question = path.match(
      /^\/api\/v1\/questions\/([a-f0-9-]+)\/decision$/,
    );
    if (question && req.method === "POST") {
      const v = await body(req);
      store.questions.answer(question[1]!, v.action, v.content);
      store.audit("question_owner_decision", {
        id: question[1],
        action: v.action,
      });
      json(res, 200, { ok: true });
      return;
    }
    if (path === "/api/v1/permissions" && req.method === "GET") {
      json(res, 200, { items: store.pendingPermissions() });
      return;
    }
    const permission = path.match(
      /^\/api\/v1\/permissions\/([a-f0-9-]+)\/decision$/,
    );
    if (permission && req.method === "POST") {
      const value = await body(req);
      store.decision(permission[1]!, value.option_id ?? null);
      json(res, 200, { ok: true });
      return;
    }
    if (path === "/api/v1/lifecycle" && req.method === "POST") {
      const value = await body(req);
      ensure(
        ["pause", "resume"].includes(value.action),
        "Choose pause or resume",
      );
      if (value.action === "pause") {
        config.enabled = false;
        save(home, config);
        await engine.pause();
      } else {
        ready(home, config);
        ensure(
          authReady &&
            startup ===
              JSON.stringify([
                config.server,
                config.teams.client_id,
                config.teams.tenant_id,
              ]),
          "Restart the service to apply its Teams registration or listener settings",
        );
        config.enabled = true;
        save(home, config);
        engine.pump();
      }
      store.audit("lifecycle", { enabled: config.enabled });
      json(res, 200, { enabled: config.enabled });
      return;
    }
    if (path === "/api/v1/check" && req.method === "POST") {
      ensure(!config.enabled, "Pause before checking the ACP endpoint");
      try {
        json(res, 200, await check(config, home));
      } catch (error) {
        if (error instanceof AgentAuthenticationRequired) {
          json(res, 409, { error: error.message, code: "agent_auth_required" });
        } else throw error;
      }
      return;
    }
    if (path === "/api/v1/manifest" && req.method === "GET") {
      json(res, 200, manifest(config));
      return;
    }
    if (path === "/api/v1/views" && req.method === "POST") {
      const id = randomUUID(),
        state = {
          page: "overview",
          conversation: null,
          filter: "",
          focus: "refresh",
        };
      store.db
        .prepare("INSERT INTO views VALUES(?,1,?)")
        .run(id, JSON.stringify(state));
      json(res, 201, { id, revision: 1, state });
      return;
    }
    const view = path.match(/^\/api\/v1\/views\/([a-f0-9-]+)$/);
    if (view) {
      const row = store.db
        .prepare("SELECT * FROM views WHERE id=?")
        .get(view[1]!) as
        | { id: string; revision: number; state: string }
        | undefined;
      ensure(row, "View not found");
      if (req.method === "GET") {
        json(res, 200, { ...row, state: JSON.parse(row.state) });
        return;
      }
      if (req.method === "PUT") {
        const value = await body(req);
        ensure(value.revision === row.revision, "View changed; reload first");
        const state = value.state;
        ensure(
          state &&
            Object.keys(state).every((k) =>
              [
                "page",
                "conversation",
                "filter",
                "focus",
                "question_drafts",
              ].includes(k),
            ),
          "Unsupported view state",
        );
        ensure(
          state.question_drafts === undefined ||
            (state.question_drafts &&
              typeof state.question_drafts === "object" &&
              !Array.isArray(state.question_drafts) &&
              JSON.stringify(state.question_drafts).length <= 32768),
          "Invalid question drafts",
        );
        ensure(
          [
            "overview",
            "activity",
            "conversations",
            "permissions",
            "questions",
          ].includes(state.page) &&
            (state.conversation === null ||
              /^[a-f0-9]{64}$/.test(state.conversation)) &&
            typeof state.filter === "string" &&
            state.filter.length <= 200 &&
            [
              "refresh",
              "filter",
              "pause",
              "resume",
              "page",
              "graph-sync",
              "",
            ].includes(state.focus),
          "Invalid view state",
        );
        store.db
          .prepare("UPDATE views SET revision=revision+1,state=? WHERE id=?")
          .run(JSON.stringify(state), row.id);
        json(res, 200, { id: row.id, revision: row.revision + 1, state });
        return;
      }
    }
    json(res, 404, { error: "Unknown operation" });
  });
  engine = new Runtime(
    home,
    store,
    () => config,
    async (message, text, files = []) => {
      const media = prepareDelivery(config, store, message, files);
      if (media.notices.length) text += "\n\n" + media.notices.join("\n");
      ensure(app, "Teams is not configured");
      const delivery = app.api
        .clone({ serviceUrl: message.service_url })
        .conversations.createActivity(message.conversation, {
          type: "message",
          text,
          textFormat: "extendedmarkdown",
          attachments: media.attachments,
        });
      // Bound even credential acquisition, which occurs before the HTTP request.
      // A timeout cannot establish that Teams did not accept the message.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const response = await Promise.race([
        delivery,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Teams delivery timed out")),
            30000,
          );
        }),
      ]).finally(() => clearTimeout(timer));
      ensure(typeof response.id === "string", "Missing Teams delivery receipt");
      return response.id;
    },
  );
  poller = new GraphPoller(
    graph,
    store,
    engine,
    () => config,
    (message, path, raw) => hydrateGraph(config, message, path, raw, graph),
  );
  if (native.settings && updateHeld(home, config.id)) hold(true);
  try {
    if (
      config.teams.client_id &&
      config.teams.tenant_id &&
      existsSync(join(home, "secrets", "client-secret"))
    ) {
      app = new App({
        clientId: config.teams.client_id,
        tenantId: config.teams.tenant_id,
        clientSecret: readPrivate(join(home, "secrets", "client-secret")),
        cloud: PUBLIC,
        httpServerAdapter: transport,
        dangerouslyAllowUnauthenticatedRequests: false,
        skipAuth: false,
        logger: sdkLog,
        client: { timeout: 20000 },
        state: false,
        serviceUrl: "https://smba.trafficmanager.net/teams",
      });
      app.on("message", async ({ activity, ref }) => {
        const message = normalize(config, activity, ref);
        if (!message || !config.enabled) return;
        const hydrated = await hydrateActivity(config, message, activity);
        engine.receiveMessage(hydrated);
      });
      app.on("file.consent.accept", async ({ activity, send }) => {
        const attachment = await fileConsent(config, store, activity);
        if (attachment)
          await send({ type: "message", attachments: [attachment] });
        return { status: 200 };
      });
      app.on("file.consent.decline", async ({ activity }) => {
        await fileConsent(config, store, activity);
        return { status: 200 };
      });
      await app.initialize();
      authReady = true;
    } else ensure(!config.enabled, "Teams credentials are missing");
    await transport.start(config.server.port);
  } catch (e) {
    await poller.close();
    await engine.close();
    store.close();
    release();
    throw e;
  }
  closeForUpdate = async () => {
    config.enabled = false;
    await poller.close();
    await engine.close();
    await transport.stop();
    store.close();
    release();
  };
  return {
    port: transport.address(),
    store,
    engine,
    app,
    transport,
    close: closeForUpdate,
  };
}
