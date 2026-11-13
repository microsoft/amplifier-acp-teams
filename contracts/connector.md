# Teams participation and delivery

For Teams installation owners, ACP endpoints and management clients. The promise:
an independent agent can participate through Teams within its authenticated tenant,
conversation and delivery boundaries. It implements the umbrella
[Connection](https://github.com/microsoft/amplifier-constellation/blob/main/contracts/connection.md)
role; the contract below adds Teams-specific obligations.

**Example:** A team invites an agent into a channel thread. The connector uses the
validated Teams route for replies and only the approved resources for context.
A private control answer is not published as though a Teams participant said it.

## Local commitments

1. **Authenticate the Teams source.** Use the Microsoft Teams SDK's ingress
   verification, then enforce the configured tenant and conversation scope. A
   payload cannot supply its own trusted authentication. Exclude targeted private
   group messages from public room history. Exact registration, cloud scope and
   trust checks belong to the [protocol reference](../docs/connector-reference.md#authentication-and-boundaries).
2. **Respect platform consent.** Personal/mentioned interaction and ambient group
   participation have different permission needs. Optional Graph ingestion uses
   explicitly configured resources and the existing app's consent; initial history
   supplies context rather than fresh requests. Deduplicate Graph/Bot Framework
   overlap. Do not silently obtain tenant-wide archive access. [Tenant permissions](../docs/tenant-permissions.md)
   and [Graph/media](../docs/graph-and-media.md) own exact grants and limits.
3. **Bind work to its Teams destination.** Tenant, conversation, thread and endpoint
   identify session routing. Reply only through the validated originating route;
   no cross-room send tool is implied. Loading depends on advertised capability.
   [Session handling](../docs/session-handling.md) documents current replacement
   fallback separately from the shared continuity promise; it is not proof that
   an old engine session or its effects were recovered.
4. **Represent actual delivery and content access.** Preserve queued, attempted,
   delivered and uncertain outcomes. A send already in flight may not be recalled;
   losing its result does not permit an automatic resend. Map files and media to
   negotiated ACP content types. Unsupported, oversized or unauthorized content
   has an explicit result; transfer URLs and Graph tokens stay outside prompts.
   Exact formatting, file-consent and transfer behavior belongs to the
   [protocol reference](../docs/connector-reference.md#conversation-and-delivery-boundary).
5. **Keep management and participant authority separate.** Management has its own
   credential, distinct from Teams and agent credentials. Private permissions,
   owner questions and sign-in remain outside Teams conversation history. Answers
   use the connector owner's authority, not an impersonated participant. Opening
   a sign-in page is not authentication success. The [management API](../docs/api.md)
   and [owner-question reference](../docs/connector-reference.md#owner-questions-and-agent-authentication)
   define the exact supported interactions.

Shared attention, work authority, continuity and outcome meanings live in the
[umbrella agreements](README.md); this contract specifies their Teams boundary.

**Check:** Validate correct and incorrect tenants/routes, targeted private group
messages, duplicate Graph/Bot events, context-only initial sync, lost send replies,
media denial and owner questions. Check actual destinations and observed effects.
[Validation](../docs/validation.md) separates disposable checks from real tenant
consent, delivery and human interaction.

**Left open:** Product UX, agent internals and collaboration strategy. The supplied
ACP session routing does not prescribe the agent’s internal workers or sessions.
Current commercial-cloud registration scope and unsupported platform operations remain
explicit in the technical references; this document does not expand them.

<!-- Keep published section links useful. Exact detail is linked above. -->
<a id="conversation-and-delivery-boundary"></a>
<a id="authentication-and-boundaries"></a>
<a id="owner-questions-and-agent-authentication"></a>
