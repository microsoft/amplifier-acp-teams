# Find the agreement for your change

This map does not duplicate the shared promises. Start with the Constellation
[family agreement](https://github.com/microsoft/amplifier-constellation/blob/main/contracts/family.v1-candidate.md)
for ownership and composition, and the [interaction agreement](https://github.com/microsoft/amplifier-constellation/blob/main/contracts/experience.v1-candidate.md)
for source, audience and destination. Then follow only the boundaries relevant to
your outcome in the [shared contract map](https://github.com/microsoft/amplifier-constellation/blob/main/contracts/README.md).
Shared documents keep their stated acceptance scope; a candidate is not silently
ratified by a link here.

## Local homes

| If your work changes… | Authoritative Teams home |
| --- | --- |
| Purpose and design space | [Vision](../docs/VISION.md) |
| Teams routing, trust, delivery and owner questions | [Connector boundary](connector.md) |
| Management requests, configuration and control UI state | [Management API](../docs/api.md) |
| Graph ingestion, resource scope and media transfer | [Graph and media](../docs/graph-and-media.md) |
| External tenant authorization and installation prerequisites | [Tenant permissions](../docs/tenant-permissions.md), [installation](../docs/installation.md) |
| Current session implementation | [Session handling](../docs/session-handling.md) |

The local boundary was extracted from this repository's connector documentation;
it creates no new shared protocol. Current session fallback and admission defaults
are implementation details, not exceptions to the shared recovery and engagement
intent. Exact supported behavior must be inspected when choosing a change.

## Change a boundary deliberately

Use [Converge](https://github.com/microsoft/amplifier-converge) and the umbrella
[working guide](https://github.com/microsoft/amplifier-constellation/blob/main/docs/working-together.md).
Keep a shared promise in its shared home and an exact local API in its serving
component. Link rather than copy. Guides and examples explain those homes and
must not be the only place a commitment exists.

Inspect the relevant implementation and test a useful combined outcome instead
of maintaining a second status or gap inventory. [Validation](../docs/validation.md)
explains local checks and what they cannot establish. This map neither advertises
an unimplemented capability nor authorizes installation changes.
