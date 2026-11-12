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
