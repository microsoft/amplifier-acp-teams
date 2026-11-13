# A useful teammate in Teams

Bring a continuing agent into the conversations where the organization works.
People should understand where it participates, what it can access and whether
its contribution reached the intended people, without operating its machinery.

This connector supplies the [Connection](https://github.com/microsoft/amplifier-constellation/blob/main/contracts/connection.md)
into Teams. Teams provides the human Experience and owns its Conversations,
including organizational identity, chats and channel threads. The agent endpoint
retains its identity and internal design behind the declared ACP interface; it
need not use a particular engine or hosting architecture. This component owns
Teams authentication, routing, scoped Graph/media access and delivery.

For example, a group asks an agent to help prepare a decision. It uses the permitted
discussion and shared material, asks a useful question, and returns its contribution
to the original thread. A focused application could present that same source-owned
conversation without replacing Teams or inventing a second copy of the work.

Favor existing Teams conversations and a self-contained installation. Tenant consent
remains part of making the connection usable. Management controls can be used directly
by authorized clients; they need not become chat messages. Shared services can deepen
collaboration without a required central application. Administration pages are one
client of those controls, not the settled product design.

Judge useful work, correct audience and delivery, and the combined user and
administrator effort to authorize, direct and recover it. Reuse what already works
before adding another mechanism.

The [Constellation vision](https://github.com/microsoft/amplifier-constellation/blob/main/docs/VISION.md)
owns the wider ambition and five primitives. The [contract map](../contracts/README.md)
links shared promises and this component's Teams-specific interfaces.
