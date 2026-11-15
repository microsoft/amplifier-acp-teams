# Teams Connector for Amplifier

Bring an existing agent into Microsoft Teams personal chats, group chats and
channel threads. Teams holds the conversations; an ACP-compatible endpoint
supplies the agent.

Part of [Amplifier Constellation](https://github.com/microsoft/amplifier-constellation).

## Get started

You need an installed, authorized ACP agent and the Microsoft 365 permissions
needed to configure a Teams app. Tenant approval is separate from installing this
connector; review the [tenant requirements](docs/tenant-permissions.md) first.

1. Download the matching [Teams Connector release](https://github.com/microsoft/amplifier-acp-teams/releases)
   for Windows, macOS or Linux, and extract the complete package.
2. Open **Teams Connector** and create the local account.
3. Follow [native setup](docs/native-installation.md) to connect the agent and
   configure the Teams app, credentials and callback.
4. Complete tenant authorization before enabling the connection. Setup starts paused.

The package includes Node and its dependencies. It does not provision an agent,
a Microsoft 365 tenant or callback hosting. Each connector installation keeps its
own process, bot identity and work records; other Constellation services are optional.

## Help and integration

- [Native installation and updates](docs/native-installation.md)
- [Source and server installation](docs/installation.md)
- [Tenant permissions](docs/tenant-permissions.md) and [Graph/media access](docs/graph-and-media.md)
- [Management API](docs/api.md) and [session recovery](docs/session-handling.md)
- [Contributor entry](AGENTS.md)

## Contributing

Invited collaborators: follow [Join the work](https://github.com/microsoft/amplifier-constellation#join-the-work)
within your agreed access and scope. The notice below covers general public intake.

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
