import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialize, save } from "../dist/config.js";
import { serve } from "../dist/server.js";
const tenant = "11111111-1111-1111-1111-111111111111";
test("original submission inspection is authorized, exact, retained, and read-only", async () => {
  const home = mkdtempSync(join(tmpdir(), "teams-source-"));
  let running;
  try {
    const c = initialize(home);
    c.teams.tenant_id = tenant;
    c.teams.conversations = ["room"];
    save(home, c, 1);
    running = await serve(home);
    const token = readFileSync(join(home, "secrets/control-token"), "utf8");
    const source = {
      tenant,
      conversation: "room",
      id: "original",
      revision: "v1",
      sender: "human",
    };
    const m = {
      ...source,
      key: "key",
      kind: "channel",
      time: Date.now(),
      text: "PRIVATE SOURCE",
      attachments: [],
      service_url: "https://smba.trafficmanager.net/amer/",
      bot_id: "bot",
      sender_name: "Human",
      addressed: true,
    };
    running.store.ingest(m, true, 100);
    const j = running.store.claim(new Set());
    running.store.finish(j.id, "uncertain", "Lost reply", "PRIVATE ANSWER");
    for (let n = 0; n < 20; n++) {
      running.store.ingest({ ...m, id: "new-" + n }, true, 100);
      const next = running.store.claim(new Set());
      running.store.finish(next.id, "pass");
    }
    const inspect = async (s, auth = true) =>
      fetch(`http://127.0.0.1:${running.port}/api/v1/submissions/inspect`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(auth ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ sources: [s] }),
      });
    assert.equal((await inspect(source, false)).status, 401);
    const response = await inspect(source);
    assert.equal(response.status, 200);
    const v = await response.json();
    assert.equal(v.items[0].attempts[0].job_id, j.id);
    assert.equal(v.items[0].attempts[0].publication.state, "uncertain");
    assert.equal(v.items[0].completion, "not_established");
    assert(!JSON.stringify(v).includes("PRIVATE"));
    for (const key of ["tenant", "conversation", "sender", "revision"]) {
      const wrong = await (await inspect({ ...source, [key]: "wrong" })).json();
      assert.equal(wrong.items[0].state, "unknown");
      assert.deepEqual(wrong.items[0].attempts, []);
    }
    assert.equal(
      running.store.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,
      21,
    );
  } finally {
    await running?.close();
    rmSync(home, { recursive: true, force: true });
  }
});

import { Store } from "../dist/store.js";
import { issueContextGrant, contextQuery } from "../dist/context.js";
import { runTurn } from "../dist/acp.js";
import { inspectSubmissions, sourceReference } from "../dist/submissions.js";
import { writeFileSync } from "node:fs";
function fixtureMessage(id = "original") {
  return {
    id,
    revision: "revision-one",
    tenant,
    conversation: "room",
    key: "key",
    kind: "channel",
    time: Date.now(),
    text: "PRIVATE SOURCE",
    attachments: [],
    service_url: "https://smba.trafficmanager.net/amer/",
    bot_id: "bot",
    sender: "human",
    sender_name: "Human",
    addressed: true,
  };
}
test("source grants reject forged, cross-room, changed actor, expired and revoked access", () => {
  const home = mkdtempSync(join(tmpdir(), "teams-grant-"));
  const c = initialize(home);
  c.context.enabled = true;
  c.teams.tenant_id = tenant;
  c.teams.conversations = ["room"];
  const store = new Store(home);
  try {
    const m = fixtureMessage();
    store.ingest(m, true, 100);
    const job = store.claim(new Set());
    const grant = issueContextGrant(store, c, job);
    const request = {
      operation: "authorize",
      access: { mode: "grant", grant: grant.grant },
    };
    assert.equal(contextQuery(store, c, request).actor_id, "human");
    assert.equal(contextQuery(store, c, request).owner, false);
    assert.throws(() =>
      contextQuery(store, c, { ...request, conversation_id: "elsewhere" }),
    );
    assert.throws(() =>
      contextQuery(store, c, { ...request, actor_id: "someone" }),
    );
    assert.throws(() =>
      contextQuery(store, c, {
        ...request,
        access: { mode: "grant", grant: "0".repeat(64) },
      }),
    );
    assert.throws(() =>
      issueContextGrant(store, c, {
        ...job,
        message: { ...m, sender: "someone" },
      }),
    );
    assert.throws(() =>
      contextQuery(store, { ...c, revision: c.revision + 1 }, request),
    );
    assert.throws(() =>
      contextQuery(
        store,
        { ...c, teams: { ...c.teams, tenant_id: "another" } },
        request,
      ),
    );
    assert.throws(() =>
      contextQuery(
        store,
        { ...c, teams: { ...c.teams, conversations: [] } },
        request,
      ),
    );
    const read = contextQuery(store, c, {
      ...request,
      operation: "read",
      conversation_id: "room",
    });
    assert.equal(read.messages[0].id, m.id);
    assert.equal(read.complete, false);
    store.db
      .prepare(
        "UPDATE jobs SET context_grant=json_set(context_grant,'$.expires',0) WHERE id=?",
      )
      .run(job.id);
    assert.throws(() => contextQuery(store, c, request));
  } finally {
    store.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("actual SDK prompts carry original source and scoped grant; error/lost replies never replay", async () => {
  for (const mode of ["supported", "plain", "error", "lost"]) {
    const home = mkdtempSync(join(tmpdir(), "teams-source-sdk-"));
    let running;
    try {
      const c = initialize(home);
      c.context.enabled = mode !== "plain";
      c.teams.tenant_id = tenant;
      c.teams.conversations = ["room"];
      c.acp.command = process.env.TEAMS_TEST_PYTHON || "python3";
      c.acp.cwd = home;
      const script = join(home, "source.py");
      writeFileSync(
        script,
        `import sys,json,pathlib,urllib.request,os
root=pathlib.Path(sys.argv[1]);mode=sys.argv[2];metadata=None
def out(v):print(json.dumps({'jsonrpc':'2.0',**v}),flush=True)
for line in sys.stdin:
 r=json.loads(line);m=r.get('method');p=r.get('params',{});i=r.get('id')
 if m=='initialize':
  result={'protocolVersion':1,'agentCapabilities':{}}
  if mode!='plain':result['_meta']={'io.github.bkrabach.agent-instance':{'inputContinuity':{'sourceDelivery':{'version':1,'metadata':'com.microsoft.amplifier.source-delivery','ordinaryPrompts':True,'workReferences':True,'receiptsMethod':'_amplifier/source_receipts'}}}}
 elif m=='session/new':
  if mode!='plain':
   grant=p['_meta']['io.github.bkrabach.conversation'];assert grant['provider_id'].startswith('teams:')
   request=urllib.request.Request(os.environ['FIXTURE_URL']+'/context/v1/query',data=json.dumps({'operation':'authorize','access':{'mode':'grant','grant':grant['grant']}}).encode(),headers={'Authorization':'Bearer '+os.environ['FIXTURE_TOKEN'],'content-type':'application/json'})
   with urllib.request.urlopen(request) as response:binding=json.load(response)
   assert binding['actor_id']=='human' and binding['conversation_id']=='room' and binding['owner']==False
  result={'sessionId':'source-session'}
 elif m=='session/prompt':
  metadata=p.get('_meta',{}).get('com.microsoft.amplifier.source-delivery');assert (metadata is not None)==(mode!='plain')
  if metadata:assert metadata['sources'][0]['revision']=='revision-one'
  with (root/'prompts').open('a') as f:f.write('1\\n')
  if mode=='lost':sys.exit(0)
  if mode=='error':out({'id':i,'error':{'code':-32603,'message':'fixture failure'}});continue
  out({'method':'session/update','params':{'sessionId':'source-session','update':{'sessionUpdate':'agent_message_chunk','content':{'type':'text','text':'Inspected.'}}}});result={'stopReason':'end_turn'}
 elif m=='_amplifier/source_receipts':
  assert mode in ['supported','error'];assert p['sources']==metadata['sources'];s=p['sources'][0]
  result={'version':1,'coverage':{'delivery':'recent_session_records','work':'retained_session_records','missing':'unknown'},'receipts':[{'sourceId':s['id'],'revision':s['revision'],'occurredAt':s['occurredAt'],'inputId':metadata['inputId'],'state':'incorporated','incorporated':True,'completion':'not_established','work':[{'id':'one','state':'accepted'},{'id':'two','state':'proposed'}]}]}
 else:result={}
 if i is not None:out({'id':i,'result':result})
`,
      );
      c.acp.args = [script, home, mode];
      save(home, c, 1);
      running = await serve(home);
      c.acp.env = {
        FIXTURE_URL: `http://127.0.0.1:${running.port}`,
        FIXTURE_TOKEN: readFileSync(
          join(home, "secrets/control-token"),
          "utf8",
        ),
      };
      const m = fixtureMessage();
      running.store.ingest(m, true, 100);
      const job = running.store.claim(new Set());
      let error;
      try {
        await runTurn(
          c,
          home,
          running.store,
          job,
          new AbortController().signal,
        );
      } catch (e) {
        error = e;
      }
      assert.equal(!!error, ["error", "lost"].includes(mode), String(error));
      const instance = inspectSubmissions(running.store, c, {
        sources: [sourceReference(m)],
      }).items[0].attempts[0].instance;
      assert.equal(
        instance.state,
        mode === "plain"
          ? "unsupported"
          : mode === "lost"
            ? "unknown"
            : "observed",
      );
      if (["supported", "error"].includes(mode))
        assert.equal(instance.work.length, 2);
      assert.equal(readFileSync(join(home, "prompts"), "utf8"), "1\n");
    } finally {
      await running?.close();
      rmSync(home, { recursive: true, force: true });
    }
  }
});
