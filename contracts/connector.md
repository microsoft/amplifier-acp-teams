# Teams connector boundary

This document owns Teams-specific behavior. Shared meaning and intended recovery
remain in the [Constellation agreements](https://github.com/microsoft/amplifier-constellation/blob/main/contracts/README.md);
this document does not create exceptions to them. The [management API](../docs/api.md)
and [Graph/media reference](../docs/graph-and-media.md) own exact local shapes.

## Conversation and delivery boundary

- Personal chats and explicit mentions receive a reply. With `teams.participation: "ambient"`, unmentioned group messages may result in `[[PASS]]` and no contribution. The generated manifest adds `ChannelMessage.Read.Group` and `ChatMessage.Read.Chat` only for ambient mode; the team/chat owner consents when installing/updating the app, subject to tenant policy. See Microsoft’s [all-messages guidance](https://learn.microsoft.com/microsoftteams/platform/bots/how-to/conversations/channel-messages-with-rsc).
- Teams Bot Framework ingress does not deliver other agents’ messages. The optional [Graph ingestion path](../docs/graph-and-media.md) polls explicitly configured chats/channels with the existing app’s resource-specific consent, projects their history, and deduplicates Bot Framework/Graph overlap. Initial sync is context only; later new messages can trigger the ordinary ACP flow.
- Each tenant/conversation/thread has its own ACP binding. Session loading depends on the endpoint's advertised capability. The shared recovery agreement governs intended continuity; see [current session handling](../docs/session-handling.md) for the implementation behavior that must be considered when changing recovery.
- Replies go only to the originating conversation/thread, using the service URL from the validated Teams activity. Text uses Teams extended Markdown, including tables and fenced code. There is no cross-room send tool.
- Optional media handling supplies current-message files as standard ACP image/audio/resource/text blocks according to the agent’s advertised capabilities. Personal-chat file cards and configured Graph inline content are supported. Native output files use personal-chat file-consent cards; small images can be embedded in groups. Unsupported, unauthorized and oversized content is reported explicitly. Transfer URLs and Graph tokens never enter the model prompt. [Setup and limits](../docs/graph-and-media.md).
- Work and delivery stay scoped to their conversation. Pausing cancels queued/model work and outstanding permissions. A send already in flight cannot be recalled; if its result is lost, it remains **uncertain** and is not automatically resent. Local admission defaults are configuration details, not a definition of the shared human-engagement promise.
- ACP client filesystem/terminal tools are not advertised. The independently configured agent can use its own tools. ACP permission requests appear in the authenticated dashboard/API, expire after two minutes, and offer only single-use choices. No chat content authorizes an approval.

## Authentication and boundaries

The Microsoft Teams SDK owns `/api/messages` authentication: signature/JWKS, issuer, audience, token lifetime and service URL checks. Both SDK auth bypass options are explicitly false; unconfigured registration returns 503. The HTTP adapter never supplies a pre-authenticated token. The configured tenant and allowed conversation list are checked again after SDK authentication. Targeted private messages inside group conversations are excluded rather than accidentally projected into public room history. Commercial-cloud single-tenant registrations are the current scope.

Management uses its own bearer token, separate from Teams credentials and agent credentials. API routes, received history, permissions and view state require that token. There is no public history endpoint, permissive CORS or token-in-URL login. Credential values never enter dashboard view state or the activity log. The default HTTP listener is for local use or a TLS-terminating proxy; it is not a substitute for public HTTPS.

SDK diagnostics are reduced to generic operational events to avoid recording credentials or message bodies. The local database is private to the installation owner and contains received messages, bounded inspection results, jobs and delivery receipts. Optional Graph reads stay within explicitly configured conversations; the adapter never searches a tenant-wide archive or queries another connector. Do not point unrelated agents at the same installation state.

## Owner questions and agent authentication

The authenticated connector dashboard includes **Questions for owner**. Ordinary
ACP agents can request validated primitive/enum forms or an explicit provider-page
link. These responses use the connector owner's authority; they do not impersonate
a Teams participant. No question contents, answers, or sign-in URLs are posted to
the Teams room. The [management API](../docs/api.md) exposes the same operations to automation.

On AUTH_REQUIRED, supported agent methods can be chosen in the dashboard, then
`authenticate` runs on the same connection and session setup retries once. No
prompt is replayed. Terminal-only methods still need host sign-in. Questions are
memory-only and cancel on stop, disconnect, expiry, or restart. Unsupported form
constraints are rejected. Credentials belong only on the provider's sign-in page;
opening that page does not certify that sign-in completed.

Protocol and dashboard behavior is fixture-tested. Live tenant authentication,
Teams delivery, and human interaction remain a separate deployment verification.
