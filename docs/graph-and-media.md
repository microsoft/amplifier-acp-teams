# Graph history, other agents, and attachments

These are optional connector features. Existing installations keep both Graph and
media disabled when reading an older configuration. All work still reaches the
independently configured agent through ordinary ACP; no Agent Instance extension
is required.

## Graph conversation ingestion

After registering and installing the Teams app, put the exact base conversation
IDs in `teams.conversations`. Add the corresponding resources under `graph`:

```json
{
  "graph": {
    "enabled": true,
    "poll_seconds": 30,
    "include_bots": true,
    "targets": [
      {
        "kind": "chat",
        "conversation_id": "19:YOUR_CHAT@thread.v2",
        "chat_id": "19:YOUR_CHAT@thread.v2"
      },
      {
        "kind": "channel",
        "conversation_id": "19:YOUR_CHANNEL@thread.tacv2",
        "team_id": "YOUR_TEAM_GROUP_UUID",
        "channel_id": "19:YOUR_CHANNEL@thread.tacv2"
      }
    ]
  }
}
```

The app uses its configured tenant, client ID, and private `client-secret` to
obtain a Graph application token. It requests the already consented `.default`
grants; it cannot grant itself access. The generated manifest includes the
resource-specific message permissions when Graph is enabled. Install/update that
manifest in the pilot resources. No tenant-wide message, calendar, or file scopes
are added by the adapter.

Send a normal human message to the installed bot in each selected conversation.
The SDK-validated activity establishes the outbound service address and bot
identity. A target remains `waiting_for_verified_conversation` until that happens;
operator-entered Graph IDs cannot invent an outbound route.

The first sync loads bounded context without waking the agent. Later unseen
messages created after that initial activation are eligible for the normal
mention/ambient participation policy. Both SDK and Graph deliveries use the same
conversation/message IDs, so overlapping delivery and restarts do not launch a
second turn. Other applications' messages can participate; this app's messages
are ignored as triggers. Edits/deletions update the local projection without
replaying tools and cancel pending/current work triggered by the changed message.
Channel root messages and their replies share the root's conversation key; another
root keeps its own ACP session.

The dashboard shows per-target state and exposes **Sync configured conversations**.
The same operations are `GET /api/v1/graph/status` and `POST /api/v1/graph/sync`.
A sync is operational: after initial baseline, newly observed messages can invoke
the agent and reply in the authorized conversation. A consent failure is reported
as `consent_required`; a 429 honors the supplied retry interval for automatic
polling. No credentials or private HTTP response bodies enter activity records.

Reads are deliberately bounded: up to four pages of 50 chat messages; the latest
20 channel roots and up to two pages of 50 replies per root. A resource sync has a
60-second deadline and individual HTTP calls have 15-second deadlines. Partial
pagination is reported with `truncated: true`. This is a recent working-context
projection, not a complete archive or a lossless high-volume event subscription.
Very busy resources need change-notification/delta ingestion before production use.
Graph pagination can only continue the original resource path on the fixed Graph
origin; redirects and cross-resource next links are rejected.

## Attachment configuration

```json
{
  "media": {
    "incoming": true,
    "outgoing": true,
    "max_files": 4,
    "max_file_bytes": 2097152,
    "download_hosts": ["YOUR_TENANT.sharepoint.com"]
  }
}
```

Use exact tenant-provided SharePoint/OneDrive transfer hostnames in lower case.
Wildcards, arbitrary URLs, HTTP, embedded credentials and redirects are rejected.
Additional regional OneDrive upload hosts must be entered explicitly if the tenant
returns them. This setting does not grant SharePoint permissions.

Incoming personal-file cards contain a short-lived download address. The adapter
reads it immediately, without attaching OAuth credentials, validates the bounded
bytes, and retains only the content and safe metadata in its private installation.
Signed addresses are never persisted or passed to the agent. Graph-hosted inline
content is read from the fixed authorized message path. A Graph permission denial
is an unavailable-content note; the adapter does not request broader access.

Plain text, Markdown, CSV and JSON work with any ACP agent. Image, audio and PDF
content require the appropriate ACP `promptCapabilities` (`image`, `audio`, or
`embeddedContext`). Files become native ACP content blocks, never local filesystem
references. Limits are four files, 2 MiB each, and 200 KB for text. Unknown formats,
wrong signatures, absent grants and capability mismatches get an explicit note.
History and inspection APIs expose metadata only; prior file bytes are not
retransmitted merely because a message appears in history.

Outgoing native image/audio/resource blocks are handled only when they are agent
messages, not tool-output or thought chunks. Personal conversations receive Teams
file-consent cards. Accepting a card must come from the same tenant, personal chat,
bot and human as the original request. A transfer is single-use; it expires after
30 minutes. A timeout is uncertain and is not replayed automatically. On success,
Teams gets a file-info card with its ordinary SharePoint URL. Transfer bodies are
removed from the pending delivery record after completion/decline/expiry.

Small inline images can be delivered in group conversations. Larger images and
other files need a separately chosen group file destination and audience-safe file
permissions; this version explains that limitation and offers the personal-chat
path. It does not create a public download server or publish files into a global
shared drive. Personal-file downloads, inline content and file-consent delivery all
still require a real tenant validation run before declaring Teams media live.

## Validation evidence

Twenty checks pass on Node 22.23.2: the existing SDK auth/ACP/isolation checks,
ten Graph/media checks (including an actual independent ACP process receiving an
image and returning a text resource), and the real desktop/phone browser check.
Graph and transfer HTTP are deterministic fixtures; they do not validate real
Microsoft tenant grants, a successful live token exchange, or Teams rendering.

Primary references checked November 2 UTC / November 1 Pacific, 2026:

- [Channel messages and reply-chain ordering](https://learn.microsoft.com/en-us/graph/api/channel-list-messages)
- [Chat messages and application RSC](https://learn.microsoft.com/en-us/graph/api/chat-list-messages?view=graph-rest-1.0)
- [Hosted contents](https://learn.microsoft.com/en-us/graph/api/chatmessage-list-hostedcontents?view=graph-rest-1.0)
- [File download and consent-upload flow](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4)
- [Inline images and platform limits](https://microsoft.github.io/teams-sdk/csharp/in-depth-guides/file-handling/sending-inline-images/)
- [Extended Markdown](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/format-your-bot-messages)
