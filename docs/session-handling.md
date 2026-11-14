# Current ACP session handling

This is an implementation description, not a relaxation of the shared
[work continuity agreement](https://github.com/microsoft/amplifier-constellation/blob/main/contracts/work-continuity.md). Inspect the source and the relevant outcome when choosing recovery work.

`src/acp.ts` keys sessions by tenant/conversation/thread and endpoint. With a saved
binding and advertised `loadSession`, it loads that exact session. A load error,
timeout or closed transport fails the current input without creating a replacement
or sending a prompt. Sign-in requirements keep their existing owner question flow.
The binding remains available for a later, fresh input after the endpoint recovers;
the failed input is not resubmitted automatically.

If loading is not advertised, plain ACP operation still creates a session for new
input. The existing job row records `session_transition` with the previous and new
IDs and reason `load_not_advertised`; the prompt explicitly states that the prior
session and uncertain effects were not recovered. Received history is bounded
conversation context, not restored engine state. A first session without a saved
binding is recorded as `created`, and a successful load as `loaded`. A failed load
records the previous ID with no confirmed current session. These records appear
in the existing jobs API, events and exact submission inspection; no new service
or recovery command is required.

`src/store.ts` retains session bindings across process restart while marking
running and pending jobs interrupted and in-flight sends uncertain. Generic turn
failures also retain the binding. None of these paths replays old input or proves
that unknown effects settled. Explicit pause, source invalidation or access
revocation retains its existing cancellation and binding-clearing behavior.
The connector never deletes the engine's saved session through ACP.

ACP transport uses the official `@agentclientprotocol/sdk` version pinned by the
package and lockfile. It owns framing, request IDs, correlation and cancellation.
The connector retains Teams routing, permissions, child-process lifetime and a
small transport observer for question scope; that observer does not allocate or
correlate RPC IDs. See the shared [SDK-first agreement](https://github.com/microsoft/amplifier-constellation/blob/main/contracts/engine-compatibility.md).
