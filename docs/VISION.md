# Agents that work with people in Teams

People should be able to bring a persistent agent into the conversations where
their organization works, without adopting a separate agent system for every
chat or channel. A colleague should understand where the agent is participating,
what it can access, who is making a decision and whether a result actually arrived.

Teams brings organizational identity, tenant policy, shared channels, personal
conversations and document collaboration. This connector's opportunity is to make
those capabilities useful to independently chosen agents while preserving their
meaning. Useful participation can grow beyond a question and answer: preparing
work together, coordinating responsibilities and bringing back results people can
inspect. That ambition is wider than the current prototype.

## What this component contributes

This component owns the Teams bot connection, authenticated source and destination,
conversation routing, scoped Microsoft Graph and media access, Teams delivery
receipts and installation controls. The chosen ACP endpoint owns the agent's
reasoning, identity, tools and durable work. The family [responsibility boundaries](https://github.com/microsoft/amplifier-constellation/blob/main/contracts/family.v1-candidate.md)
keep those services independently useful.

Owners can deepen this integration while other teams develop conversation
services, reasoning capabilities or entirely new experiences. Tenant setup and
permissions remain part of making the Teams connection usable; they are not an
excuse to require a central Constellation provisioning service. Existing dashboard
pages are development and administration access. They do not define the future
product UX or exhaust the Teams design space.

## How to shape the next outcome

Begin with the person's intended collaboration and the real organizational setting.
Use the [contract map](../contracts/README.md) to find existing commitments and
owners; inspect implementation and behavior for the proposed outcome. Reuse the
shared services and remove avoidable setup or coordination before adding another
mechanism. Shared changes belong with the affected owners in the umbrella;
Teams-specific choices belong here.

Evaluate useful work, understandable evidence and the effort required to authorize,
direct and correct it. The [Constellation vision](https://github.com/microsoft/amplifier-constellation/blob/main/docs/VISION.md)
and shared agreements own the broader interaction and attention expectations.
Local implementation details are not substitutes for that direction.
