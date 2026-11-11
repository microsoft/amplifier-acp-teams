# Validation

```sh
npm ci --ignore-scripts
npm test
npm audit
```

Core tests cover separate concurrent sessions, resume/restart, deduplication, ambient/direct routing, tenant/room/targeted-message isolation, permission decisions, cancellation, uncertain delivery, actual HTTP auth rejection, control API/view isolation, Graph app-credential routing, scoped pagination, historical-baseline handling, edit/restart deduplication, bounded media, actor-bound file consent and generic command configuration. The tests launch an independent ACP fixture process; they make no Teams or model calls.

Optional browser test:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
CHROMIUM_PATH=/absolute/path/to/chromium npm test
```

This checks real dashboard sign-in/navigation, remote view control, token clearing and desktop/phone layout. Screenshots are written only under ignored `private/`.

Actual tenant verification requires an app registration, privately provided secret,
reachable HTTPS endpoint, app installation/resource consent, and the intended
conversation IDs. Local JWT rejection, SDK peer and fixture delivery tests do not
establish a real Teams send or a successful human interaction. Record those
outcomes with the deployment being evaluated; do not infer them from fixture
success.

Primary references: [SDK trust model](https://microsoft.github.io/teams-sdk/typescript/essentials/app-authentication/trust-model/), [app authentication](https://microsoft.github.io/teams-sdk/typescript/essentials/app-authentication/), [Teams manifest](https://microsoft.github.io/teams-sdk/teams/manifest/), [messages and threading](https://microsoft.github.io/teams-sdk/typescript/essentials/sending-messages/).

See [tenant permissions](tenant-permissions.md) for the scoped admin request and [Graph and media setup](graph-and-media.md) for the opt-in configuration.
