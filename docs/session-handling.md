# Current ACP session handling

This is an implementation description, not a relaxation of the shared
[harness lifecycle](https://github.com/microsoft/amplifier-constellation/blob/main/contracts/harness-lifecycle.v1-candidate.md)
and [input continuity](https://github.com/microsoft/amplifier-constellation/blob/main/contracts/input-continuity.v1-candidate.md)
intent. Inspect the source and the relevant outcome when choosing recovery work.

`src/acp.ts` keys sessions by tenant/conversation/thread and endpoint. It uses
`session/load` only when advertised, retains successful bindings, and supplies
bounded received history and delivery receipts with new input. If session loading
fails, the current implementation can create a replacement session.

`src/store.ts` removes the local binding of a job left running across a process
restart, marks running and pending jobs interrupted, and does not automatically
replay them. It marks an in-flight send uncertain. A later message can therefore
start a new session; that is not proof that the original engine session or its
unknown effects were recovered. The implementation does not delete the engine's
saved session through ACP. Preserve this distinction when evaluating or changing
recovery.

ACP transport uses the official `@agentclientprotocol/sdk` version pinned by the
package and lockfile. It owns framing, request IDs, correlation and cancellation.
The connector retains Teams routing, permissions, child-process lifetime and a
small transport observer for question scope; that observer does not allocate or
correlate RPC IDs. See the shared [SDK-first agreement](https://github.com/microsoft/amplifier-constellation/blob/main/contracts/protocol-sdk.v1-candidate.md).
