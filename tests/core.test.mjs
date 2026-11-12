import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  initialize,
  save,
  validate,
  privateWrite,
  endpointKey,
} from "../dist/config.js";
import { AgentAuthenticationRequired, check as checkAcp } from "../dist/acp.js";
import { writeFileSync } from "node:fs";
import { Store } from "../dist/store.js";
import { Runtime, normalize } from "../dist/runtime.js";
import { serve } from "../dist/server.js";
import { manifest } from "../dist/manifest.js";
const tenant = "11111111-1111-1111-1111-111111111111",
  bot = "22222222-2222-2222-2222-222222222222";
function setup() {
  const home = mkdtempSync(join(tmpdir(), "acp-teams-check-"));
  const c = initialize(home);
  c.teams.client_id = bot;
  c.teams.tenant_id = tenant;
  c.teams.conversations = ["room"];
  c.acp.command = (process.env.TEAMS_TEST_PYTHON || "python3");
  c.acp.args = [resolve("tests/acp-fixture.py")];
  c.acp.timeout_seconds = 5;
  return {
    home,
    c,
    clean() {
      rmSync(home, { recursive: true, force: true });
    },
  };
}
function activity(
  id = "one",
  text = "hello",
  kind = "personal",
  conversation = "dm",
) {
  return {
    type: "message",
    id,
    text,
    channelId: "msteams",
    from: { id: "human", name: "Human", role: "user" },
    recipient: { id: "28:" + bot },
    conversation: { id: conversation, conversationType: kind },
    channelData: { tenant: { id: tenant } },
    serviceUrl: "https://smba.trafficmanager.net/amer/",
  };
}
function reference(a) {
  return {
    conversation: a.conversation,
    serviceUrl: a.serviceUrl,
    bot: a.recipient,
  };
}
async function until(fn) {
  for (let i = 0; i < 100; i++) {
    if (fn()) return;
    await delay(30);
  }
  throw new Error("Condition did not become true");
}

test("normalization enforces tenant, room, targeted-message privacy and sender boundaries", () => {
  const x = setup();
  try {
    const a = activity();
    assert.equal(normalize(x.c, a, reference(a)).kind, "personal");
    assert.equal(
      normalize(
        x.c,
        { ...a, channelData: { tenant: { id: bot } } },
        reference(a),
      ),
      undefined,
    );
    assert.equal(
      normalize(
        x.c,
        { ...a, recipient: { ...a.recipient, isTargeted: true } },
        reference(a),
      ),
      undefined,
    );
    assert.equal(
      normalize(x.c, { ...a, from: { id: "bot", role: "bot" } }, reference(a)),
      undefined,
    );
    const group = activity("x", "x", "groupChat", "unknown");
    assert.equal(normalize(x.c, group, reference(group)), undefined);
    const evil = {
      ...reference(a),
      serviceUrl: "https://smba.trafficmanager.net.evil.test/",
    };
    assert.throws(() => normalize(x.c, a, evil));
    const thread = activity("x", "hello", "channel", "room");
    const n = normalize(x.c, thread, {
      ...reference(thread),
      conversation: { ...thread.conversation, id: "room;messageid=parent" },
    });
    assert.equal(n.conversation, "room;messageid=parent");
    assert.notEqual(n.key, normalize(x.c, a, reference(a)).key);
  } finally {
    x.clean();
  }
});

test("real ACP process: separate concurrent sessions, direct replies, resume, and no duplicate activity", async () => {
  const x = setup(),
    store = new Store(x.home);
  x.c.enabled = true;
  const sent = [];
  const runtime = new Runtime(
    x.home,
    store,
    () => x.c,
    async (m, t) => {
      sent.push([m, t]);
      return "sent-" + sent.length;
    },
  );
  try {
    const a = activity("one", "hello"),
      b = activity("two", "hello", "personal", "other");
    assert.equal(runtime.receive(a, reference(a)), true);
    assert.equal(runtime.receive(a, reference(a)), false);
    runtime.receive(b, reference(b));
    await until(() => sent.length === 2);
    const sessions = store.db
      .prepare("SELECT key,id FROM sessions ORDER BY key")
      .all();
    assert.equal(new Set(sessions.map((v) => v.id)).size, 2);
    const again = activity("three", "hello");
    runtime.receive(again, reference(again));
    await until(() => sent.length === 3);
    assert.deepEqual(
      store.db.prepare("SELECT key,id FROM sessions ORDER BY key").all(),
      sessions,
    );
    store.recover();
    assert.deepEqual(
      store.db.prepare("SELECT key,id FROM sessions ORDER BY key").all(),
      sessions,
    );
  } finally {
    await runtime.close();
    store.close();
    x.clean();
  }
});

test("ambient pass, targeted mention and metadata-only attachment handling", async () => {
  const x = setup(),
    store = new Store(x.home);
  x.c.enabled = true;
  x.c.teams.participation = "ambient";
  const sent = [];
  const runtime = new Runtime(
    x.home,
    store,
    () => x.c,
    async (m, t) => {
      sent.push(t);
      return "sent";
    },
  );
  try {
    const a = activity("one", "ambient-fixture", "groupChat", "room");
    a.attachments = [
      {
        name: "private.png",
        contentType: "image/png",
        contentUrl: "https://internal.private/token",
      },
    ];
    runtime.receive(a, reference(a));
    await until(() =>
      store.db.prepare("SELECT 1 FROM jobs WHERE status='pass'").get(),
    );
    assert.equal(sent.length, 0);
    const saved = JSON.stringify(
      store.history(normalize(x.c, a, reference(a)).key),
    );
    assert.ok(saved.includes("private.png"));
    assert.ok(!saved.includes("internal.private"));
    const b = activity("two", "reply please", "groupChat", "room");
    b.entities = [{ type: "mention", mentioned: { id: "28:" + bot } }];
    assert.equal(normalize(x.c, b, reference(b)).addressed, true);
    runtime.receive(b, reference(b));
    await until(() => sent.length === 1);
  } finally {
    await runtime.close();
    store.close();
    x.clean();
  }
});

test("pause kills ACP work, cancels requests and prevents sends", async () => {
  const x = setup(),
    store = new Store(x.home);
  x.c.enabled = true;
  let sent = 0;
  const runtime = new Runtime(
    x.home,
    store,
    () => x.c,
    async () => {
      sent++;
      return "sent";
    },
  );
  try {
    const a = activity("one", "wait-fixture");
    runtime.receive(a, reference(a));
    await until(() => runtime.active.size === 1);
    x.c.enabled = false;
    await runtime.pause();
    assert.equal(sent, 0);
    assert.equal(
      store.db.prepare("SELECT status FROM jobs").get().status,
      "cancelled",
    );
    assert.equal(runtime.active.size, 0);
  } finally {
    await runtime.close();
    store.close();
    x.clean();
  }
});

test("uncertain delivery is never replayed after restart", async () => {
  const x = setup(),
    store = new Store(x.home);
  x.c.enabled = true;
  let sends = 0;
  const runtime = new Runtime(
    x.home,
    store,
    () => x.c,
    async () => {
      sends++;
      throw new Error("Lost reply");
    },
  );
  try {
    const a = activity();
    runtime.receive(a, reference(a));
    await until(() =>
      store.db.prepare("SELECT 1 FROM jobs WHERE status='uncertain'").get(),
    );
    store.recover();
    runtime.pump();
    await delay(100);
    assert.equal(sends, 1);
    assert.equal(
      store.db.prepare("SELECT status FROM jobs").get().status,
      "uncertain",
    );
  } finally {
    await runtime.close();
    store.close();
    x.clean();
  }
});

test("ACP permission is bound to a job and only authenticated control resolves it", async () => {
  const x = setup(),
    store = new Store(x.home);
  x.c.enabled = true;
  const sent = [];
  const runtime = new Runtime(
    x.home,
    store,
    () => x.c,
    async (m, t) => {
      sent.push(t);
      return "sent";
    },
  );
  try {
    const a = activity("one", "ask-permission-fixture");
    runtime.receive(a, reference(a));
    await until(() =>
      store.pendingPermissions().some((p) => p.status === "pending"),
    );
    const p = store.pendingPermissions()[0];
    assert.throws(() => store.decision(p.id, "made-up"));
    store.decision(p.id, "allow");
    await until(() => sent.length === 1);
    assert.match(sent[0], /PERMISSION_selected/);
    assert.throws(() => store.decision(p.id, "allow"));
    for (const invalid of ["duplicate", "malformed"]) {
      const rejected = activity(invalid, invalid + "-permission-fixture");
      runtime.receive(rejected, reference(rejected));
      await until(() => sent.length === (invalid === "duplicate" ? 2 : 3));
      assert.match(sent.at(-1), /PERMISSION_cancelled/);
    }
    assert.equal(
      store.pendingPermissions().length,
      1,
      "Ambiguous options are never offered for approval",
    );
  } finally {
    await runtime.close();
    store.close();
    x.clean();
  }
});

test("SDK rejects unauthenticated and unsigned Teams messages; control API, view state and lock isolation", async () => {
  const x = setup();
  save(x.home, x.c);
  privateWrite(join(x.home, "secrets", "client-secret"), "fixture-not-real");
  const running = await serve(x.home);
  const base = "http://127.0.0.1:" + running.port,
    token = readFileSync(join(x.home, "secrets", "control-token"), "utf8"),
    headers = {
      authorization: "Bearer " + token,
      "content-type": "application/json",
    };
  try {
    assert.equal((await fetch(base + "/api/v1/status")).status, 401);
    assert.equal(
      (
        await fetch(base + "/api/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(activity()),
        })
      ).status,
      401,
    );
    const jwt =
      Buffer.from('{"alg":"none"}').toString("base64url") +
      "." +
      Buffer.from(
        JSON.stringify({
          aud: bot,
          iss: "https://api.botframework.com",
          exp: 9999999999,
        }),
      ).toString("base64url") +
      ".";
    assert.equal(
      (
        await fetch(base + "/api/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer " + jwt,
          },
          body: JSON.stringify(activity()),
        })
      ).status,
      401,
    );
    assert.equal(
      running.store.db.prepare("SELECT COUNT(*) AS n FROM messages").get().n,
      0,
    );
    assert.equal(
      (await fetch(base + "/api/v1/config", { headers })).status,
      200,
    );
    assert.equal(
      (
        await fetch(base + "/api/v1/status", {
          headers: { ...headers, origin: "https://attacker.test" },
        })
      ).status,
      400,
    );
    const view = await (
      await fetch(base + "/api/v1/views", {
        method: "POST",
        headers,
        body: "{}",
      })
    ).json();
    assert.equal(view.state.page, "overview");
    const state = {
      page: "permissions",
      conversation: null,
      filter: "Read",
      focus: "refresh",
    };
    const response = await fetch(base + "/api/v1/views/" + view.id, {
      method: "PUT",
      headers,
      body: JSON.stringify({ revision: 1, state }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).state, state);
    assert.equal(
      (
        await fetch(base + "/api/v1/views/" + view.id, {
          method: "PUT",
          headers,
          body: JSON.stringify({
            revision: 2,
            state: { ...state, token: "do-not-store" },
          }),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(base + "/api/v1/check", {
          method: "POST",
          headers,
          body: "{}",
        })
      ).status,
      200,
    );
    await assert.rejects(() => serve(x.home), /already has a running process/);
  } finally {
    await running.close();
    x.clean();
  }
});

test("configuration and manifest preserve generic ACP and separate identity", () => {
  const x = setup();
  try {
    x.c.acp.command = "/usr/bin/ssh";
    x.c.acp.args = ["other-host", "ordinary-acp-agent"];
    assert.equal(validate(x.c).acp.command, "/usr/bin/ssh");
    x.c.server.public_url = "https://teams.example.test";
    const m = manifest(x.c);
    assert.equal(m.bots[0].botId, bot);
    assert.deepEqual(m.bots[0].scopes, ["personal", "team", "groupChat"]);
    assert.equal(m.authorization, undefined);
    x.c.teams.participation = "ambient";
    const ambient = manifest(x.c);
    assert.equal(ambient.webApplicationInfo.id, bot);
    assert.deepEqual(
      ambient.authorization.permissions.resourceSpecific.map((p) => p.name),
      ["ChannelMessage.Read.Group", "ChatMessage.Read.Chat"],
    );
    assert.throws(() =>
      validate({
        ...x.c,
        server: { ...x.c.server, public_url: "http://example.test" },
      }),
    );
    assert.throws(() => validate({ ...x.c, unknown: true }));
  } finally {
    x.clean();
  }
});

test("bare ACP auth-required is actionable and does not echo credential-bearing errors", async () => {
  const x = setup();
  try {
    const script = join(x.home, "auth.py");
    writeFileSync(
      script,
      `import sys,json
for line in sys.stdin:
 r=json.loads(line)
 result={'protocolVersion':1,'agentCapabilities':{},'authMethods':[{'id':'login','name':'Browser login'}]} if r['method']=='initialize' else None
 print(json.dumps({'jsonrpc':'2.0','id':r['id'],**({'result':result} if result else {'error':{'code':-32000,'message':'DO NOT DISPLAY SECRET'}})}),flush=True)
`,
    );
    x.c.acp.args = [script];
    await assert.rejects(
      checkAcp(x.c, x.home),
      (error) =>
        error instanceof AgentAuthenticationRequired &&
        error.message.includes("same service account") &&
        !error.message.includes("SECRET"),
    );
  } finally {
    x.clean();
  }
});

test("auth expiry on session/load preserves the saved binding and sends no replacement prompt", async () => {
  const x = setup();
  const store = new Store(x.home);
  let runtime;
  try {
    const script = join(x.home, "expired-auth.py");
    const log = join(x.home, "auth-methods.jsonl");
    writeFileSync(
      script,
      `import sys,json
from pathlib import Path
for line in sys.stdin:
 r=json.loads(line)
 with Path(sys.argv[1]).open('a') as stream: stream.write(json.dumps(r['method'])+'\\n')
 result={'protocolVersion':1,'agentCapabilities':{'loadSession':True},'authMethods':[{'id':'login','name':'Browser login'}]} if r['method']=='initialize' else None
 print(json.dumps({'jsonrpc':'2.0','id':r['id'],**({'result':result} if result else {'error':{'code':-32000,'message':'PRIVATE ENDPOINT DETAIL'}})}),flush=True)
`,
    );
    x.c.acp.args = [script, log];
    x.c.enabled = true;
    const a = activity("expired-auth", "Continue what we started");
    const message = normalize(x.c, a, reference(a));
    store.bindSession(message.key, endpointKey(x.c), "previous-session");
    let sends = 0;
    runtime = new Runtime(
      x.home,
      store,
      () => x.c,
      async () => {
        sends++;
        return "must-not-send";
      },
    );
    runtime.receive(a, reference(a));
    await until(()=>store.questions.list().length===1);
    store.questions.answer(store.questions.list()[0].id,'cancel');

    await until(
      () =>
        store.db
          .prepare("SELECT COUNT(*) AS count FROM jobs WHERE status='failed'")
          .get().count === 1,
    );
    const job = store.db
      .prepare("SELECT note FROM jobs WHERE status='failed'")
      .get();
    assert.match(job.note, /same service account/);
    assert.doesNotMatch(job.note, /PRIVATE ENDPOINT DETAIL/);
    assert.equal(
      store.session(message.key, endpointKey(x.c)),
      "previous-session",
    );
    assert.equal(sends, 0);
    assert.deepEqual(
      readFileSync(log, "utf8").trim().split("\n").map(JSON.parse),
      ["initialize", "session/load"],
    );
  } finally {
    if (runtime) await runtime.close();
    store.close();
    x.clean();
  }
});
