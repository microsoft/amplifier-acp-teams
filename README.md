# ACP Teams Adapter

Native package setup for Windows, macOS and Linux is described in
[Native installation](docs/native-installation.md). It starts paused and keeps
Teams authorization separate from the local app account.

Bring an independently configured agent into Microsoft Teams personal chats,
group chats and channel threads. Teams remains the source of its conversations;
the chosen ACP endpoint supplies the agent.

Part of [Amplifier Constellation](https://github.com/microsoft/amplifier-constellation).
Start with the [vision](docs/VISION.md) and [contract map](contracts/README.md)
when shaping a capability or integrating another service.

```text
Teams → Microsoft SDK authentication → conversation queue → ordinary ACP stdio
                                                ↓
                                    confirmed Teams delivery
```

## Start here

Download the matching native package from [Releases](https://github.com/microsoft/amplifier-acp-teams/releases), extract it, and open **Teams Connector**. It includes Node and its dependencies. [Native installation](docs/native-installation.md) covers the local account, setup, and updates; Teams tenant approval remains separate.

### Build from source

The Linux source installer below is for contributors and administrators. It is not a prerequisite for the native app.

```sh
git clone https://github.com/microsoft/amplifier-acp-teams.git
cd amplifier-acp-teams
./install.sh "$HOME/.local/share/acp-teams-adapter/my-agent"
```

Follow [installation](docs/installation.md) for the ACP endpoint, private
credentials, callback and app setup. [Tenant permissions](docs/tenant-permissions.md)
separates installation work from Microsoft 365 approval. The connector does not
provision a tenant, hosting infrastructure or an agent runtime.

Each installation has its own folder, process, bot identity and work journal.
Instance, other connectors and a fleet manager are optional peers. The packaged
dashboard is development and administration access, not a settled product UX;
the [management API](docs/api.md) exposes its controls independently.

## Find the boundary for your work

- **Bring an idea:** [vision](docs/VISION.md), [contract map](contracts/README.md), and [working instructions](AGENTS.md).
- **Design Teams behavior:** [connector boundary](contracts/connector.md).
- **Integrate controls:** [management API](docs/api.md).
- **Read or transfer content:** [Graph and media](docs/graph-and-media.md).
- **Inspect session recovery:** [current session handling](docs/session-handling.md).
- **Check a change:** [validation](docs/validation.md). Local fixtures do not establish live tenant authorization, delivery or human interaction.

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
