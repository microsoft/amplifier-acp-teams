import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initialize, privateWrite, validate } from "../dist/config.js";
import { Store, projection } from "../dist/store.js";
import { Runtime, normalize, conversationKey } from "../dist/runtime.js";
import {
  GraphClient,
  GraphPoller,
  graphMessage,
  resourcePath,
  boundedBody,
} from "../dist/graph.js";
import {
  inputContent,
  outputFile,
  hydrateActivity,
  prepareDelivery,
  fileConsent,
  fileUrl,
  inlineImage,
} from "../dist/media.js";
import { runTurn } from "../dist/acp.js";
const tenant = "11111111-1111-1111-1111-111111111111",
  bot = "22222222-2222-2222-2222-222222222222";
const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
function setup() {
  const home = mkdtempSync(join(tmpdir(), "teams-graph-media-"));
  const c = initialize(home);
  Object.assign(c.teams, {
    client_id: bot,
    tenant_id: tenant,
    conversations: ["chat", "channel"],
    participation: "ambient",
  });
  c.graph = {
    enabled: true,
    poll_seconds: 30,
    include_bots: true,
    targets: [{ kind: "chat", conversation_id: "chat", chat_id: "chat" }],
  };
  c.media = {
    incoming: true,
    outgoing: true,
    max_files: 4,
    max_file_bytes: 2 * 1024 * 1024,
    download_hosts: ["tenant.sharepoint.com"],
  };
  c.acp.command = (process.env.TEAMS_TEST_PYTHON || "python3");
  c.acp.args = [resolve("tests/acp-fixture.py")];
  c.enabled = true;
  privateWrite(join(home, "secrets", "client-secret"), "private-oauth-secret");
  const store = new Store(home);
  const route = {
    id: "1",
    key: conversationKey(tenant, "chat"),
    tenant,
    conversation: "chat",
    kind: "groupChat",
    bot_id: "28:" + bot,
    service_url: "https://smba.trafficmanager.net/amer/",
    sender: "human",
    sender_name: "Human",
    text: "hello",
    addressed: false,
    attachments: [],
    time: Date.now(),
  };
  return {
    home,
    c,
    store,
    route,
    clean() {
      store.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}
const response = (value, headers = {}) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json", ...headers },
  });

test("Graph uses app credentials only at the configured tenant; pagination cannot escape the authorized resource", async () => {
  const x = setup();
  const calls = [];
  try {
    const client = new GraphClient(
      x.home,
      () => x.c,
      async (url, options) => {
        calls.push([String(url), options]);
        if (String(url).includes("/oauth2/"))
          return response({
            access_token: "private-graph-token",
            expires_in: 3600,
          });
        return response({
          value: [],
          "@odata.nextLink":
            "https://graph.microsoft.com/v1.0/chats/another/messages?$skiptoken=secret",
        });
      },
    );
    await assert.rejects(
      client.collection("/chats/chat/messages"),
      /authorized resource/,
    );
    assert.equal(calls.length, 2);
    assert.equal(
      calls[0][0],
      `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    );
    assert.equal(
      calls[0][1].body.get("scope"),
      "https://graph.microsoft.com/.default",
    );
    assert.equal(calls[1][1].redirect, "error");
    assert.equal(
      calls[1][1].headers.Authorization,
      "Bearer private-graph-token",
    );
    await assert.rejects(client.response("//evil.test/path"), /Invalid/);
    assert.equal(calls.length, 2);
  } finally {
    x.clean();
  }
});

test("Graph baseline is context only, then SDK/Graph overlap and restarts deduplicate bot work", async () => {
  const x = setup();
  x.store.rememberRoute(x.route);
  let items = [];
  const client = { collection: async () => ({ items, truncated: false }) };
  let queued = 0;
  const invalidated = [];
  const engine = {
    invalidateMessage(key, id) {
      invalidated.push([key, id]);
    },
    receiveMessage(m, historical) {
      const accepted = x.store.ingest(m, !historical, 100);
      if (accepted) queued++;
      return accepted;
    },
  };
  const poller = new GraphPoller(client, x.store, engine, () => x.c);
  try {
    const raw = (id, text = "hi", created = Date.now() + 1000) => ({
      id,
      createdDateTime: new Date(created).toISOString(),
      body: { contentType: "html", content: `<p>${text}</p>` },
      from: { application: { id: "another-agent", displayName: "Builder" } },
    });
    items = [raw("10", "old")];
    await poller.poll(true);
    assert.equal(queued, 0);
    assert.equal(x.store.history(x.route.key).at(-1).text, "old");
    items.push(raw("11", "new"));
    await poller.poll(true);
    await poller.poll(true);
    assert.equal(queued, 1);
    const overlap = {
      ...x.route,
      id: "12",
      text: "SDK copy",
      time: Date.now() + 1000,
    };
    x.store.ingest(overlap, true, 100);
    items.push(raw("12", "Graph copy"));
    await poller.poll(true);
    assert.equal(queued, 1);
    items[1].body.content = "<p>edited</p>";
    await poller.poll(true);
    assert.equal(queued, 1);
    assert.equal(
      x.store.history(x.route.key).find((m) => m.id === "11").text,
      "edited",
    );
    items[1] = { id: "11", deletedDateTime: new Date().toISOString() };
    await poller.poll(true);
    assert.equal(queued, 1);
    assert.equal(
      x.store.history(x.route.key).find((m) => m.id === "11").text,
      "[Message deleted in Teams]",
    );
    assert.deepEqual(invalidated.at(-1), [x.route.key, "11"]);
    await poller.close();
    const reopened = new GraphPoller(client, x.store, engine, () => x.c);
    await reopened.poll(true);
    await reopened.close();
    assert.equal(queued, 1);
    assert.ok(poller.status()[0].initialized);
  } finally {
    await poller.close();
    x.clean();
  }
});

test("Graph never polls before a verified conversation and fails closed when access is removed", async () => {
  const x = setup();
  let calls = 0;
  const poller = new GraphPoller(
    {
      collection: async () => {
        calls++;
        return { items: [], truncated: false };
      },
    },
    x.store,
    {
      receiveMessage() {
        throw Error("unexpected");
      },
    },
    () => x.c,
  );
  try {
    await poller.poll(true);
    assert.equal(calls, 0);
    assert.equal(poller.status()[0].state, "waiting_for_verified_conversation");
    x.store.rememberRoute(x.route);
    x.c.teams.conversations = [];
    await poller.poll(true);
    assert.equal(calls, 0);
  } finally {
    await poller.close();
    x.clean();
  }
});

test("Graph channel parents and replies map to one thread, separate from another parent; foreign sources are rejected", () => {
  const x = setup();
  try {
    const target = {
      kind: "channel",
      team_id: tenant,
      channel_id: "channel",
      conversation_id: "channel",
    };
    const route = { ...x.route, kind: "channel", conversation: "channel" };
    const raw = {
      id: "100",
      createdDateTime: new Date().toISOString(),
      body: {
        contentType: "html",
        content: '<p>Read &amp; <at id="0">Helper</at><br>next</p>',
      },
      from: { user: { id: "user", tenantId: tenant } },
      mentions: [{ mentioned: { application: { id: bot } } }],
    };
    const parent = graphMessage(x.c, target, route, raw);
    const reply = graphMessage(
      x.c,
      target,
      route,
      { ...raw, id: "101", replyToId: "100" },
      "100",
    );
    const other = graphMessage(x.c, target, route, { ...raw, id: "102" });
    assert.equal(parent.key, reply.key);
    assert.notEqual(parent.key, other.key);
    assert.equal(parent.addressed, true);
    assert.equal(parent.text, "Read & Helper\nnext");
    assert.equal(
      graphMessage(x.c, target, route, {
        ...raw,
        channelIdentity: { teamId: "foreign", channelId: "channel" },
      }),
      undefined,
    );
    assert.equal(
      graphMessage(x.c, target, route, {
        ...raw,
        from: { application: { id: bot } },
      }),
      undefined,
    );
    assert.equal(
      graphMessage(x.c, target, route, {
        ...raw,
        from: { user: { id: "user", tenantId: "foreign" } },
      }),
      undefined,
    );
    assert.equal(
      resourcePath(target),
      `/teams/${tenant}/channels/channel/messages`,
    );
  } finally {
    x.clean();
  }
});

test("media is bounded, capability-aware and stripped from conversation history projections", async () => {
  const x = setup();
  try {
    const m = {
      ...x.route,
      attachments: [
        {
          name: "image.png",
          content_type: "image/png",
          data: png.toString("base64"),
        },
      ],
    };
    const hidden = inputContent(x.c, m, {});
    assert.match(hidden[0].text, /does not advertise/);
    const blocks = inputContent(x.c, m, { image: true });
    assert.equal(blocks[0].type, "image");
    assert.equal(projection(m).attachments[0].data, undefined);
    x.store.ingest(m, false, 100);
    assert.equal(x.store.history(m.key)[0].attachments[0].data, undefined);
    assert.throws(() =>
      outputFile(x.c, {
        type: "image",
        mimeType: "image/png",
        data: Buffer.from("not-image").toString("base64"),
      }),
    );
    await assert.rejects(boundedBody(new Response("too big"), 3), /size limit/);
    x.c.media.incoming = false;
    assert.match(inputContent(x.c, m, { image: true })[0].text, /disabled/);
  } finally {
    x.clean();
  }
});

test("personal file downloads use configured tenant hosts without OAuth and never persist signed URLs", async () => {
  const x = setup();
  try {
    const secretUrl = "https://tenant.sharepoint.com/download?private=secret";
    const m = { ...x.route, kind: "personal" };
    const raw = {
      attachments: [
        {
          name: "notes.txt",
          contentType: "application/vnd.microsoft.teams.file.download.info",
          content: { downloadUrl: secretUrl, fileType: "txt" },
        },
      ],
    };
    let calls = 0;
    const loaded = await hydrateActivity(x.c, m, raw, async (url, options) => {
      calls++;
      assert.equal(String(url), secretUrl);
      assert.equal(options.headers, undefined);
      assert.equal(options.redirect, "error");
      return new Response("Hello Alex");
    });
    assert.equal(calls, 1);
    assert.equal(inputContent(x.c, loaded, {})[0].type, "text");
    assert.ok(!JSON.stringify(loaded).includes("private=secret"));
    raw.attachments[0].content.downloadUrl = "https://evil.test/download";
    const blocked = await hydrateActivity(x.c, m, raw, async () => {
      throw Error("must not fetch");
    });
    assert.match(blocked.attachments[0].note, /not configured/);
    assert.throws(() =>
      fileUrl(x.c, "https://tenant.sharepoint.com@evil.test/x"),
    );
  } finally {
    x.clean();
  }
});

test("file consent is bound to the original participant, tenant and room; upload is single-use", async () => {
  const x = setup();
  try {
    const message = { ...x.route, kind: "personal" };
    const file = {
      name: "result.txt",
      mime_type: "text/plain",
      data: Buffer.from("Done").toString("base64"),
    };
    const prepared = prepareDelivery(x.c, x.store, message, [file]);
    const id = prepared.attachments[0].content.acceptContext.delivery_id;
    const a = {
      channelId: "msteams",
      channelData: { tenant: { id: tenant } },
      conversation: { id: "chat", conversationType: "personal" },
      from: { id: "human" },
      recipient: { id: message.bot_id },
      value: {
        action: "accept",
        context: { delivery_id: id },
        uploadInfo: {
          uploadUrl: "https://tenant.sharepoint.com/upload?secret=1",
          contentUrl: "https://tenant.sharepoint.com/result.txt",
          uniqueId: "file-1",
        },
      },
    };
    await assert.rejects(
      fileConsent(
        x.c,
        x.store,
        { ...a, from: { id: "someone-else" } },
        async () => {
          throw Error("must not upload");
        },
      ),
      /another participant/,
    );
    let uploads = 0;
    const transfer = async (_url, options) => {
      uploads++;
      assert.equal(options.headers.Authorization, undefined);
      assert.equal(options.method, "PUT");
      return new Response("{}", { status: 201 });
    };
    const card = await fileConsent(x.c, x.store, a, transfer);
    assert.equal(
      card.contentType,
      "application/vnd.microsoft.teams.card.file.info",
    );
    assert.equal(uploads, 1);
    await assert.rejects(
      fileConsent(x.c, x.store, a, transfer),
      /already handled/,
    );
    assert.equal(uploads, 1);
    assert.equal(
      x.store.db.prepare("SELECT file FROM file_deliveries WHERE id=?").get(id)
        .file,
      "{}",
    );
    assert.ok(!JSON.stringify(x.store.activity()).includes("secret=1"));
  } finally {
    x.clean();
  }
});

test("uncertain upload is not retried and group output never creates public file endpoints", async () => {
  const x = setup();
  try {
    const file = {
      name: "result.pdf",
      mime_type: "application/pdf",
      data: Buffer.from("%PDF-fixture").toString("base64"),
    };
    const group = prepareDelivery(x.c, x.store, x.route, [file]);
    assert.equal(group.attachments.length, 0);
    assert.match(group.notices[0], /personal chat/);
    const message = { ...x.route, kind: "personal" };
    const prepared = prepareDelivery(x.c, x.store, message, [file]);
    const id = prepared.attachments[0].content.acceptContext.delivery_id;
    const a = {
      channelId: "msteams",
      channelData: { tenant: { id: tenant } },
      conversation: { id: "chat", conversationType: "personal" },
      from: { id: "human" },
      recipient: { id: message.bot_id },
      value: {
        action: "accept",
        context: { delivery_id: id },
        uploadInfo: {
          uploadUrl: "https://tenant.sharepoint.com/upload",
          contentUrl: "https://tenant.sharepoint.com/result.pdf",
          uniqueId: "file",
        },
      },
    };
    await assert.rejects(
      fileConsent(x.c, x.store, a, async () => {
        throw Error("timeout");
      }),
      /will not be repeated/,
    );
    assert.equal(
      x.store.db
        .prepare("SELECT status FROM file_deliveries WHERE id=?")
        .get(id).status,
      "uncertain",
    );
  } finally {
    x.clean();
  }
});

test("ordinary ACP process receives supported media and returns native file output", async () => {
  const x = setup();
  try {
    const message = {
      ...x.route,
      text: "media-fixture",
      attachments: [
        {
          name: "input.png",
          content_type: "image/png",
          data: png.toString("base64"),
        },
      ],
    };
    x.store.ingest(message, true, 10);
    const job = x.store.claim(new Set());
    const result = await runTurn(
      x.c,
      x.home,
      x.store,
      job,
      new AbortController().signal,
    );
    assert.equal(result.pass, false);
    assert.match(result.text, /MEDIA_IMAGE_RECEIVED/);
    assert.equal(result.files[0].mime_type, "text/plain");
  } finally {
    x.clean();
  }
});

test("config migration preserves opt-in defaults and rejects mismatched resource mappings", () => {
  const x = setup();
  try {
    const old = { ...x.c };
    delete old.graph;
    delete old.media;
    const migrated = validate(old);
    assert.equal(migrated.graph.enabled, false);
    assert.equal(migrated.media.incoming, false);
    assert.throws(
      () =>
        validate({
          ...x.c,
          graph: {
            ...x.c.graph,
            targets: [
              { kind: "chat", conversation_id: "chat", chat_id: "other" },
            ],
          },
        }),
      /must match/,
    );
    assert.throws(
      () =>
        validate({
          ...x.c,
          media: { ...x.c.media, download_hosts: ["evil.test"] },
        }),
      /exact tenant/,
    );
  } finally {
    x.clean();
  }
});

test("inline group images stay within Teams dimensions and embedded size limits", () => {
  const image = Buffer.alloc(32);
  png.copy(image);
  image.writeUInt32BE(1024, 16);
  image.writeUInt32BE(512, 20);
  assert(inlineImage("image/png", image));
  image.writeUInt32BE(1025, 16);
  assert(!inlineImage("image/png", image));
  assert(
    !inlineImage("image/png", Buffer.concat([image, Buffer.alloc(12000)])),
  );
  assert(!inlineImage("image/png", png));
  assert(!inlineImage("image/jpeg", Buffer.from([255, 216, 255, 192, 0, 0])));
  assert(!inlineImage("image/gif", Buffer.from("GIF89a")));
});
