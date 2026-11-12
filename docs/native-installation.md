# Native installation

The native package includes the Teams connector, its fixed Node runtime and
production dependencies. Open **Teams Connector.app** on macOS,
**acp-teams-adapter.exe** on Windows, or **acp-teams-adapter** on Linux. Keep the
extracted download together. Rust, Node, npm, Python and WSL are not user setup
requirements. Packages cover x64 and ARM64 on each OS; preview downloads are
unsigned and not notarized. Native CI is distinct from publisher signing and a
real tenant installation.

Choose a local password. Existing authorized connections are not imported or
changed. The new connector is paused, without a Teams app, tenant or ACP agent.
[Teams setup](installation.md) still owns bot registration, platform consent,
the public HTTPS callback and the agent endpoint. Installation does not grant
those permissions or send a message. The optional startup choice uses the
current user's OS startup mechanism; if that fails, the account remains usable
and the dashboard reports the failure.

Management stays at the saved `http://127.0.0.1:<port>` address. It uses a local
Argon2id password and browser session with same-origin/CSRF checks. Only the
Microsoft SDK handles `/api/messages`; exposing the callback does not expose
management or authorize a tenant. Reverse proxies must publish only that route
and the nonprivate `/about`, `/privacy` and `/terms` pages. Do not publish the
local dashboard. Legacy installs retain their bearer token and configuration.

The installation's `native.json` binds its identity and local origin. A launch
verifies the listener before sending a saved management credential, on the same
TCP connection. Setup publishes a complete private directory without replacing
an existing one. The original connector state, delivery uncertainty and saved
sessions stay in its installation; signing out only removes the browser session.
No shared identity, provisioning service or global runtime is required.

This source candidate covers native setup and restart. A supported explicit
package-update/recovery flow is a separate release prerequisite. Reopening a
new download is not an update operation; do not manually replace a used
installation's runtime or data. The launcher refuses mixed installed bundle
versions. No automatic updater or release polling is added here.

## Building and verifying a package

Use `npm ci --ignore-scripts`, `npm test`, and the native Rust launcher tests.
`python scripts/package-native.py` runs only at build time; it verifies the
vendored umbrella Node support, official archive, actual native executable,
production lockfile and distributor licenses. Each package has a checksum and
metadata file. The complete bundled file inventory is checked during setup.
The six native jobs run the extracted app with a PATH containing no developer
tools, a Unicode home, local account creation, saved-view restart and child
shutdown. The Linux browser fixture covers a lost committed account reply and
phone layout. All fixtures use disposable homes with no tenant/model calls.
