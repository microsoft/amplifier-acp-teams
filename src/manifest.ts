import { ensure, type Config } from "./config.js";
export function manifest(c: Config) {
  ensure(
    c.teams.client_id && c.server.public_url,
    "Set client ID and public HTTPS origin first",
  );
  return {
    $schema:
      "https://developer.microsoft.com/json-schemas/teams/v1.22/MicrosoftTeams.schema.json",
    manifestVersion: "1.22",
    version: "0.2.1",
    id: c.teams.client_id,
    developer: {
      name: "Connection owner",
      websiteUrl: c.server.public_url + "/about",
      privacyUrl: c.server.public_url + "/privacy",
      termsOfUseUrl: c.server.public_url + "/terms",
    },
    name: { short: c.label.slice(0, 30), full: c.label },
    description: {
      short: "An independent ACP agent in Teams.",
      full: "Connect an independently configured ACP agent to personal chats, group chats and team conversations.",
    },
    icons: { outline: "outline.png", color: "color.png" },
    accentColor: "#175d57",
    bots: [
      {
        botId: c.teams.client_id,
        scopes: ["personal", "team", "groupChat"],
        supportsFiles: c.media.incoming || c.media.outgoing,
        isNotificationOnly: false,
      },
    ],
    validDomains: [new URL(c.server.public_url).hostname],
    ...(c.teams.participation === "ambient" || c.graph.enabled
      ? {
          webApplicationInfo: {
            id: c.teams.client_id,
            resource: "https://RscBasedStoreApp",
          },
          authorization: {
            permissions: {
              resourceSpecific: [
                { name: "ChannelMessage.Read.Group", type: "Application" },
                { name: "ChatMessage.Read.Chat", type: "Application" },
              ],
            },
          },
        }
      : {}),
  };
}
