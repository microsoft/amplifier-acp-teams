# Install and operate a Teams connection

## Choose an installation

For a native download, follow [native installation](native-installation.md).
It includes its private Node runtime: do not install Node, npm, Python or Git to
use it. The native launcher opens the connector; the source CLI commands below
are not subcommands of that launcher.

### Source installation for developers and server administrators

This separate source path requires Node.js 22.13 or later, npm and Git:

```sh
git clone https://github.com/microsoft/amplifier-acp-teams.git
cd amplifier-acp-teams
./install.sh "$HOME/.local/share/acp-teams-adapter/my-agent"
```

This script does not create OS accounts, global agent configuration or Teams
resources. An installed and authenticated ACP executable is an independent
prerequisite for connecting an agent on either installation path.

## Configure the Teams connection

1. Register a **single-tenant Azure Bot** and its Microsoft Entra application. Enable its Teams channel. Use Microsoft's [registration guide](https://microsoft.github.io/teams-sdk/get-started/quickstart-register/).
2. Edit `adapter.json` in the installation folder. Set `teams.client_id`, `teams.tenant_id` and the ordinary `acp.command`, `args`, `cwd`. Keep `enabled: false` until checks pass. An SSH attach command works the same way as a local ACP program; no shell interpolation is performed.
3. Store the client secret privately. Supply the secret on stdin, not as a command-line argument. The CLI never prints it:

   ```text
   <node> <cli> secret --home /path/to/installation --name client-secret < /private/path/to/secret
   <node> <cli> check --home /path/to/installation
   ```

   The input-redirection example above uses POSIX shell or Windows Command Prompt
   syntax. In PowerShell, pipe the client-secret file to the bundled executable
   instead (replace these example installation and private file paths):

   ```powershell
   Get-Content -Raw -LiteralPath 'C:\private\client-secret.txt' | & 'C:\Teams connector\runtime\node.exe' 'C:\Teams connector\app\dist\cli.js' secret --home 'C:\Teams connector' --name client-secret
   ```

   For a native installation, `<node>` is its `runtime/node` (`runtime/node.exe`
   on Windows), and `<cli>` is its `app/dist/cli.js`, both under the installation
   folder. Use full quoted paths. For a source installation they are `node` and
   `dist/cli.js`. These are fixed installed tools, not extra downloads. Stop the
   connector before file/CLI configuration edits, then reopen the native app;
   source installations use `node dist/cli.js serve --home ...`. Live configuration
   changes instead use the paused, revision-checked management API.

4. The native app opens its local dashboard. Source hosting prints its local port and dashboard URL; open it through an SSH tunnel or your own HTTPS reverse proxy. Native installations use the local connector password. Source installations use the value in `secrets/control-token`, kept only in page memory. Management is loopback-only by default. If changing the bind address, put HTTPS in front of it before using it over a network.
5. Set a stable port and `server.public_url` to a publicly reachable HTTPS origin. Forward the Teams callback **`/api/messages`**, plus the public informational routes `/about`, `/privacy`, and `/terms`. Block all other routes on that public origin. Point the Azure Bot messaging endpoint at `https://your-origin/api/messages`. Keep the dashboard and management API on a separate private HTTPS route or SSH tunnel. An [example proxy configuration](../ops/reverse-proxy.nginx.conf) shows this separation. This adapter does not provision DNS, certificates, tunnels or Azure infrastructure.
6. In the signed-in dashboard's Overview, choose **Download Teams app package**.
   The ZIP already contains the registration-specific manifest and both icons;
   no Python or source checkout is needed. An installation owner can alternatively
   use the same exporter through its fixed CLI:

   ```text
   <node> <cli> manifest-package --home /path/to/installation --output teams-agent.zip
   ```

   The output must be a new file; an existing destination is preserved. The
   authenticated `GET /api/v1/manifest.zip` provides the same package. The existing
   `manifest` command and `GET /api/v1/manifest` still return JSON only. Export
   neither installs the app nor changes its configured permissions.

7. Install the package in the chosen Teams tenant and add the app to a personal chat, group chat or team. Add allowed group/channel conversation IDs to `teams.conversations`. Personal chats are allowed by default; group/channel participation is explicitly allowlisted. Restart after changing registration/listener settings, then **Resume connection** in the dashboard.

For unattended source hosting, run `node /absolute/repo/dist/cli.js serve --home /absolute/installation` under the host’s service manager as the installation owner. Separate folders and pinned repository checkouts let versions coexist. Service installation and fleet orchestration are deliberately independent.

## Configuration changes

CLI commands: `init`, `config [--file]`, `secret --name`, `check`, `manifest`, `manifest-package --output`, `serve`, all with `--home`. CLI/config edits should be made with the service stopped, then restarted. Live changes use the revision-checked API while paused. A used installation cannot be repointed to another Teams identity or ACP endpoint.
