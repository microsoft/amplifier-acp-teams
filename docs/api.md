# Standalone management API

Base `/api/v1`; endpoints require the native installation’s authenticated local browser session or `Authorization: Bearer <control-token>`. Native browser mutations also require their CSRF token. The token is stored only in the installation’s private `secrets/control-token` file. The public SDK-authenticated Teams callback is a different boundary at `/api/messages`.

| Operation | Meaning |
| --- | --- |
| `GET descriptor` | Identity, version, protocol and available operations |
| `GET config` | Current configuration, including secret reference names but never secret file values |
| `PUT config` | Complete configuration, with the last read `revision`; paused only; response includes `restart_required` |
| `GET status` | Connection state, work counts, recent conversation list and explicit current limitations |
| `GET activity?before=<seq>` | Up to 100 operational events, newest first; `next_before` continues |
| `GET conversations` | Up to 200 observed conversations |
| `GET history?key=<conversation-key>` | Bounded local received transcript for that exact conversation, at most 60 messages/60KB |
| `GET questions` | Pending owner questions and supported agent sign-in choices |
| `POST questions/{id}/decision` | `{ "action": "accept", "content": {} }` (`action` may also be `decline` or `cancel`) for the pending question; content depends on its offered schema |
| `GET permissions` | Pending and recent ACP permission requests |
| `POST permissions/{id}/decision` | `{ "option_id": "offered-single-use-option" }`, or null to cancel |
| `POST lifecycle` | `{ "action": "pause" }` or `{ "action": "resume" }` |
| `POST check` | ACP handshake and session creation while paused; no model prompt or Teams send |
| `GET graph/status` | Per-target verification, sync, rate-limit and consent state |
| `POST graph/sync` | Request a bounded sync while enabled; later newly observed messages may launch ordinary ACP work |
| `GET manifest` | Registration-specific Teams app manifest JSON |
| `GET manifest.zip` | Download `teams-agent.zip` containing that manifest and both icons; no configuration or tenant change |
| `POST views` | Create a dashboard view, returning its ID/revision/state |
| `GET views/{id}` | Read that view |
| `PUT views/{id}` | Replace state with its current revision |

View state is `{ "page": "overview|activity|conversations|permissions|questions", "conversation": null, "filter": "", "focus": "refresh" }`. `conversation` may be an observed 64-character conversation key. Focus supports `refresh`, `filter`, `pause`, `resume`, `page`, `graph-sync` or empty. The browser polls its view, so an external agent can navigate and focus the same screen. An optional `question_drafts` object stores ordinary form drafts keyed by question ID; it is bounded to 32,768 serialized characters. Credential values and configuration drafts are not view fields. The dashboard displays its view ID for orchestration.

All control uses installation-owner authority. There are no delegated scopes or multiple dashboard users. Embedding is same-origin only. More granular fleet access can be added without changing the generic ACP side.

Secrets are write-only through the CLI (`secret --name <name>`, stdin value); use `acp.secret_env` to map agent environment variables to these private file names. Teams credentials and management tokens are never inherited by the ACP child. Only a small host environment allowlist and explicit agent settings are forwarded. Do not place credential values in `acp.env`.

`status`, `history` and events describe observed facts. `sending`/`uncertain` are not confirmed delivery. A successful model turn may already have performed work, so an uncertain send is never automatically retried as another model turn.


Graph and media configuration is included in the same revision-checked `config`
resource. `status.graph` reports enabled state and per-target receipts;
`status.media` reports configured limits and pending personal file offers. History
responses contain attachment metadata, never encoded file bodies or signed transfer
URLs. File consent comes from the authenticated Teams callback and is bound to the
original tenant, personal conversation, recipient bot and requesting human. It is
not a generic management-token permission grant.

## Admission configuration

The current defaults allow two concurrent conversations, one active job per
conversation, and 60 replies per hour. These values are local configuration,
not a shared attention or human-engagement contract. Inspect `src/config.ts` and
the configured installation when evaluating admission behavior.

## Original submissions and optional Instance context

`POST /api/v1/submissions/inspect` uses the existing authenticated installation
management surface. Supply 1–16 exact references as
`{"sources":[{"tenant":"…","conversation":"…","id":"…","revision":"…","sender":"…"}]}`.
It reads existing jobs, including old settled records, and returns processing,
Teams publication and last observed Instance receipts separately. Every source
field and current configured conversation scope must match. Missing records stay
unknown, no source text is returned, and inspection never prompts or resends.
An original message can have several attempts and several work references.

The connector's opaque revision is retained when present; otherwise it is derived
from the original stored message's ID, time, text and attachment metadata. History
projections include this revision for exact inspection. An edit
therefore cannot borrow a previous revision's evidence. Replies and source
receipts do not establish completed work; a `proposed` work reference is not
accepted work. Snapshots expose observation time and are not a current work poll.
Legacy missing snapshots stay unknown; plain ACP endpoints remain supported.

Optional `context.enabled` (default `false`) exposes `/context/v1/query` on the
same server. Register `teams:<installation-id>` with the existing Instance
context-provider configuration and its private named credential; no privileged
registration happens automatically. This endpoint requires existing connector
management authentication **and** a source grant. It supports `authorize`,
`orientation` and bounded `read` for that grant's conversation, never owner-wide
access. A random grant is carried in the existing
`io.github.bkrabach.conversation` session metadata; only its hash, expiry and
source/configuration binding are retained on the existing job row. Each query
checks the tenant, conversation, originating sender, current configured access,
configuration revision and 30-minute expiry. A grant cannot select another
conversation or supplied actor. It attests a connector-observed platform input
under current configured scope; it does not claim a fresh Microsoft directory
membership lookup. Configured removal/revision changes revoke it immediately.

When the endpoint advertises Instance's `ordinaryPrompts` / `workReferences`
source-delivery profile with `promptRetry: inspectOnly`, actual prompts carry the stable job input ID and original
source revision/time. The optional context grant supplies the authenticated
actor/audience binding required for work linkage. Without that configured binding,
the receipt explicitly reports `audience_binding: unavailable`. After a terminal
result or error, receipt inspection can preserve known work even when the prompt
failed; a disconnected transport remains unknown and is never replayed. Use the
existing Instance receipt/work controls to inspect newer work state; retained
`receipt_query` contains the exact method and source/session arguments, without
authorizing a replay.

[Instance's serving interface](https://github.com/microsoft/amplifier-constellation-instance/blob/main/docs/harness.md)
owns the optional profile details. Shared behavior remains in the umbrella
[work-continuity agreement](https://github.com/microsoft/amplifier-constellation/blob/main/contracts/work-continuity.md).
