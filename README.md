# ACP Teams Adapter

Part of [Amplifier Constellation](https://github.com/microsoft/amplifier-constellation).

Connect one independently configured ACP agent to Microsoft Teams. Each installation has its own folder, process, Teams bot identity, configuration and work journal. It has no dependency on Agent Instance, Slack, the workshop or a fleet manager.

```text
Teams → Microsoft SDK JWT validation → conversation queue → ordinary ACP stdio
                                              ↓
                                  confirmed Teams delivery
```

The same agent endpoint can also be connected to other experiences. Its identity, instructions and tools remain at that endpoint. Teams conversations have separate ACP working sessions; this connector does not merge private conversations or copy another experience’s history.

## Install and configure

Requires Node.js 22.13 or later, npm, and an installed/authenticated ACP executable. Node 22.23.2 was used for validation. Node’s SQLite API is still marked experimental in that release.

```sh
git clone git@github.com:microsoft/amplifier-acp-teams.git
cd amplifier-acp-teams
./install.sh "$HOME/.local/share/acp-teams-adapter/my-agent"
```

The repository contains the standalone source and installer. No OS accounts, global agent configuration or Teams resources are created by this script.

1. Register a **single-tenant Azure Bot** and its Microsoft Entra application. Enable its Teams channel. Use Microsoft's [registration guide](https://microsoft.github.io/teams-sdk/get-started/quickstart-register/).
2. Edit `adapter.json` in the installation folder. Set `teams.client_id`, `teams.tenant_id` and the ordinary `acp.command`, `args`, `cwd`. Keep `enabled: false` until checks pass. An SSH attach command works the same way as a local ACP program; no shell interpolation is performed.
3. Store the client secret privately. Supply the secret on stdin, not as a command-line argument. The CLI never prints it:

   ```sh
   node dist/cli.js secret --home /path/to/installation --name client-secret < /private/path/to/secret
   node dist/cli.js check --home /path/to/installation
   node dist/cli.js serve --home /path/to/installation
   ```

4. The service prints its local port and dashboard URL. Open it through an SSH tunnel or your own HTTPS reverse proxy. The dashboard uses the value in `secrets/control-token`; it keeps that value only in page memory. Management is loopback-only by default. If changing the bind address, put HTTPS in front of it before using it over a network.
5. Set a stable port and `server.public_url` to a publicly reachable HTTPS origin. Forward the Teams callback **`/api/messages`**, plus the public informational routes `/about`, `/privacy`, and `/terms`. Block all other routes on that public origin. Point the Azure Bot messaging endpoint at `https://your-origin/api/messages`. Keep the dashboard and management API on a separate private HTTPS route or SSH tunnel. An [example proxy configuration](ops/reverse-proxy.nginx.conf) shows this separation. This adapter does not provision DNS, certificates, tunnels or Azure infrastructure.
6. Generate and package the manifest:

   ```sh
   node dist/cli.js manifest --home /path/to/installation > manifest.json
   python3 ops/package-manifest.py manifest.json teams-agent.zip
   ```

7. Install the package in the chosen Teams tenant and add the app to a personal chat, group chat or team. Add allowed group/channel conversation IDs to `teams.conversations`. Personal chats are allowed by default; group/channel participation is explicitly allowlisted. Restart after changing registration/listener settings, then **Resume connection** in the dashboard.

For unattended hosting, run `node /absolute/repo/dist/cli.js serve --home /absolute/installation` under the host’s service manager as the installation owner. Separate folders and pinned repository checkouts let versions coexist. Service installation and fleet orchestration are deliberately independent.

## Expected behavior

- Personal chats and explicit mentions receive a reply. With `teams.participation: "ambient"`, unmentioned group messages may result in `[[PASS]]` and no contribution. The generated manifest adds `ChannelMessage.Read.Group` and `ChatMessage.Read.Chat` only for ambient mode; the team/chat owner consents when installing/updating the app, subject to tenant policy. See Microsoft’s [all-messages guidance](https://learn.microsoft.com/microsoftteams/platform/bots/how-to/conversations/channel-messages-with-rsc).
- Teams Bot Framework ingress does not deliver other agents’ messages. The optional [Graph ingestion path](docs/graph-and-media.md) polls explicitly configured chats/channels with the existing app’s resource-specific consent, projects their history, and deduplicates Bot Framework/Graph overlap. Initial sync is context only; later new messages can trigger the ordinary ACP flow. Live multi-agent Teams validation remains pending the tenant setup.
- Each tenant/conversation/thread has its own ACP session. `loadSession` is used only when advertised. Successful session bindings survive restarts. Interrupted model work is not replayed automatically; its session is discarded. A new incoming message supplies bounded received history and delivery receipts.
- Replies go only to the originating conversation/thread, using the service URL from the validated Teams activity. Text uses Teams extended Markdown, including tables and fenced code. There is no cross-room send tool.
- Optional media handling supplies current-message files as standard ACP image/audio/resource/text blocks according to the agent’s advertised capabilities. Personal-chat file cards and configured Graph inline content are supported. Native output files use personal-chat file-consent cards; small images can be embedded in groups. Unsupported, unauthorized and oversized content is reported explicitly. Transfer URLs and Graph tokens never enter the model prompt. [Setup and limits](docs/graph-and-media.md).
- Up to two conversations work concurrently by default, with one active job per conversation and an hourly reply budget. Pausing cancels queued/model work and outstanding permissions. A send already in flight cannot be recalled; if its result is lost, it remains **uncertain** and is not automatically resent.
- ACP client filesystem/terminal tools are not advertised. The independently configured agent can use its own tools. ACP permission requests appear in the authenticated dashboard/API, expire after two minutes, and offer only single-use choices. No chat content authorizes an approval.

## Authentication and boundaries

Microsoft Teams SDK 2.1.1 owns `/api/messages` authentication: signature/JWKS, issuer, audience, token lifetime and service URL checks. Both SDK auth bypass options are explicitly false; unconfigured registration returns 503. The HTTP adapter never supplies a pre-authenticated token. The configured tenant and allowed conversation list are checked again after SDK authentication. Targeted private messages inside group conversations are excluded rather than accidentally projected into public room history. Commercial-cloud single-tenant registrations are the current scope.

Management uses its own bearer token, separate from Teams credentials and agent credentials. API routes, received history, permissions and view state require that token. There is no public history endpoint, permissive CORS or token-in-URL login. Credential values never enter dashboard view state or the activity log. The default HTTP listener is for local use or a TLS-terminating proxy; it is not a substitute for public HTTPS.

SDK diagnostics are reduced to generic operational events to avoid recording credentials or message bodies. The local database is private to the installation owner and contains received messages, bounded inspection results, jobs and delivery receipts. Optional Graph reads stay within explicitly configured conversations; the adapter never searches a tenant-wide archive or queries another connector. Do not point unrelated agents at the same installation state.

The SDK currently depends on an older MSAL Node range with a published authorization-code-flow advisory. This repository pins the compatible MSAL Node override to **7.1.0**; `npm audit` reports zero vulnerabilities for the lockfile. This adapter uses app credentials and does not implement the affected user authorization-code flow. Real Azure token acquisition remains part of the pending live validation.

## Programmatic operation

All dashboard actions and view state are available through the [management API](docs/api.md), including navigation, selected conversation, search filter and keyboard focus. There is no fleet dependency. A future manager can call this API or link to the standalone dashboard.

CLI commands: `init`, `config [--file]`, `secret --name`, `check`, `manifest`, `serve`, all with `--home`. CLI/config edits should be made with the service stopped, then restarted. Live changes use the revision-checked API while paused. A used installation cannot be repointed to another Teams identity or ACP endpoint.

## Validation

```sh
npm ci --ignore-scripts
npm test
npm audit
```

Nineteen core tests cover separate concurrent sessions, resume/restart, deduplication, ambient/direct routing, tenant/room/targeted-message isolation, permission decisions, cancellation, uncertain delivery, actual HTTP auth rejection, control API/view isolation, Graph app-credential routing, scoped pagination, historical-baseline handling, edit/restart deduplication, bounded media, actor-bound file consent and generic command configuration. The tests launch an independent ACP fixture process; they make no Teams or model calls.

Optional browser test:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
CHROMIUM_PATH=/absolute/path/to/chromium npm test
```

This checks real dashboard sign-in/navigation, remote view control, token clearing and desktop/phone layout. Screenshots are written only under ignored `private/`.

**Live Teams verification is deferred at the user's request (November 1, 2026).** Resuming it requires a tenant/app registration, privately provided secret, reachable HTTPS endpoint and app installation. Local JWT rejection and fixture delivery tests do not establish a real Teams send. No Teams registration, app installation or live message was created during local validation.

Primary references: [SDK trust model](https://microsoft.github.io/teams-sdk/typescript/essentials/app-authentication/trust-model/), [app authentication](https://microsoft.github.io/teams-sdk/typescript/essentials/app-authentication/), [Teams manifest](https://microsoft.github.io/teams-sdk/teams/manifest/), [messages and threading](https://microsoft.github.io/teams-sdk/typescript/essentials/sending-messages/).

See [tenant permissions](docs/tenant-permissions.md) for the scoped admin request and [Graph and media setup](docs/graph-and-media.md) for the opt-in configuration.

## Contributing

> [!NOTE]
> This project is not currently accepting external contributions, but we're actively working toward opening this up. We value community input and look forward to collaborating in the future. For now, feel free to fork and experiment!

Most contributions require you to agree to a
Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us
the rights to use your contribution. For details, visit [Contributor License Agreements](https://cla.opensource.microsoft.com).

When you submit a pull request, a CLA bot will automatically determine whether you need to provide
a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions
provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or
contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## Trademarks

This project may contain trademarks or logos for projects, products, or services. Authorized use of Microsoft
trademarks or logos is subject to and must follow
[Microsoft's Trademark & Brand Guidelines](https://www.microsoft.com/legal/intellectualproperty/trademarks/usage/general).
Use of Microsoft trademarks or logos in modified versions of this project must not cause confusion or imply Microsoft sponsorship.
Any use of third-party trademarks or logos are subject to those third-party's policies.
