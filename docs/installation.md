# Install and operate a Teams connection

## Installation

Requires Node.js 22.13 or later, npm, and an installed/authenticated ACP executable.

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
5. Set a stable port and `server.public_url` to a publicly reachable HTTPS origin. Forward the Teams callback **`/api/messages`**, plus the public informational routes `/about`, `/privacy`, and `/terms`. Block all other routes on that public origin. Point the Azure Bot messaging endpoint at `https://your-origin/api/messages`. Keep the dashboard and management API on a separate private HTTPS route or SSH tunnel. An [example proxy configuration](../ops/reverse-proxy.nginx.conf) shows this separation. This adapter does not provision DNS, certificates, tunnels or Azure infrastructure.
6. Generate and package the manifest:

   ```sh
   node dist/cli.js manifest --home /path/to/installation > manifest.json
   python3 ops/package-manifest.py manifest.json teams-agent.zip
   ```

7. Install the package in the chosen Teams tenant and add the app to a personal chat, group chat or team. Add allowed group/channel conversation IDs to `teams.conversations`. Personal chats are allowed by default; group/channel participation is explicitly allowlisted. Restart after changing registration/listener settings, then **Resume connection** in the dashboard.

For unattended hosting, run `node /absolute/repo/dist/cli.js serve --home /absolute/installation` under the host’s service manager as the installation owner. Separate folders and pinned repository checkouts let versions coexist. Service installation and fleet orchestration are deliberately independent.

## Configuration changes

CLI commands: `init`, `config [--file]`, `secret --name`, `check`, `manifest`, `serve`, all with `--home`. CLI/config edits should be made with the service stopped, then restarted. Live changes use the revision-checked API while paused. A used installation cannot be repointed to another Teams identity or ACP endpoint.
