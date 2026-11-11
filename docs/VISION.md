# A useful teammate in Teams

People should be able to bring a persistent agent into the conversations where
their organization works. They should understand where it participates, what it
can access and whether its contribution reached the intended people.

Teams brings organizational identity, tenant policy, chats, channel threads and
document collaboration. This connector makes those capabilities available to an
independently chosen ACP agent. It owns the Teams connection, authenticated
routing, scoped Graph and media access, and delivery. The endpoint owns reasoning
and its execution history.

For example, a group asks an agent to help prepare a decision. It can use the
permitted discussion and shared material, ask a useful question, and return its
contribution to the original thread. Organizational boundaries remain visible;
a person should not have to understand the connector's internal machinery to
work with the agent.

The design favors existing Teams conversations and a self-contained installation.
Tenant approval remains part of making that connection usable. Shared services
can deepen collaboration without requiring one central application or agent
engine. Current administration pages are access to those capabilities, not the
future product design.

Judge useful work, correct audience and delivery, and the combined user and
administrator effort to authorize, direct and recover it. Reuse existing
capabilities and remove avoidable setup before adding another mechanism.

The [Constellation vision](https://github.com/microsoft/amplifier-constellation/blob/main/docs/VISION.md)
owns the wider ambition. [Shared agreements and the Teams boundary](../contracts/README.md)
identify what others can rely on; technical references retain platform-specific
requirements and implementation limits.
