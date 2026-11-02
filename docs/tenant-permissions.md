# Tenant setup for this connector

Live Teams testing remains deferred. This describes what to request when it resumes.

| Requirement | Who supplies it | Scope |
|---|---|---|
| Single-tenant Microsoft Entra application | An app owner allowed to register applications, or an identity administrator | This app and tenant; give the operator ownership if the admin creates it |
| Azure Bot resource with Teams channel | A subscription/resource-group owner can provision it, or grant resource-group creation rights | An Azure subscription is required in addition to Microsoft 365 |
| Custom Teams app availability | Teams administrator; upload through the organizational catalog or permit custom app upload for the test users | Pilot users and chosen teams/chats |
| Receive unmentioned human messages | Install/upgrade the ambient-mode manifest and obtain resource-specific consent from the team/chat owner, subject to tenant policy | `ChannelMessage.Read.Group` for the installed team; `ChatMessage.Read.Chat` for the installed group chat |
| Public HTTPS callback | Hosting/network operator | Teams must reach `/api/messages`; a private LAN or Tailscale-only URL is insufficient |

Basic personal-chat and mention/reply operation does not require tenant-wide
Microsoft Graph message-reading permissions. Do not request Global Administrator
as the runtime identity. The application credential belongs in the adapter's
private secret store; account passwords do not belong in its configuration.

The RSC grants also authorize Graph reads for the selected resources. This
adapter now implements opt-in Graph polling for allowlisted chats/channels,
including messages from other agents, parent/reply history, durable deduplication
and initial-history suppression. A signed incoming Teams activity must establish
that conversation's delivery route before it is polled. No tenant-wide Graph
message permission is requested automatically.

Personal file transfers use Teams file consent and exact configured tenant
SharePoint/OneDrive hosts. Group reference-file downloads and large group file
uploads require a deliberately chosen destination and additional file access;
they remain unsupported. Some Graph hosted-content APIs require more than the
message RSC grant, particularly in chats. Missing access produces a clear
unavailable-content note rather than requesting broader permissions.

Live tenant verification is still pending: app registration, private credential,
public HTTPS callback, app installation/resource consent, and the actual chat or
team/channel IDs. The new Graph and transfer paths have protocol and real-process
fixture coverage, not a claimed successful Microsoft 365 send.

References checked November 1, 2026:

- [Register the Entra application and Azure Bot](https://learn.microsoft.com/en-us/microsoftteams/platform/teams-sdk/teams/azure-configuration)
- [Custom app upload and availability policies](https://learn.microsoft.com/en-us/microsoftteams/teams-custom-app-policies-and-settings)
- [RSC consent model](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/resource-specific-consent)
- [Receive all human messages; bot-delivery limitation](https://learn.microsoft.com/en-us/microsoftteams/platform/agents-in-teams/enable-receive-all-chat-messages)
- [Graph channel-message reading permissions](https://learn.microsoft.com/en-us/graph/api/channel-list-messages?view=graph-rest-1.0)
- [Graph chat-message reading permissions](https://learn.microsoft.com/en-us/graph/api/chat-list-messages?view=graph-rest-1.0)
