# n8n-nodes-openclaw-weixin

n8n community nodes for receiving Weixin messages and connecting them to workflows and AI Agents through the OpenClaw iLink Bot API.

> [!NOTE]
> Each Weixin API credential is bound to one `userId`, so create one credential for each user and use the same n8n main process for polling and waiting executions.

> [!WARNING]
> Keep the credential and login workflow private because the bot token can access the Weixin account.

## Features

- **Weixin API credential**: Stores the bot token, bot ID, optional API base URL, and required bound user ID.
- **Weixin Login Trigger**: Starts a QR login flow and returns the values needed by the Weixin API credential.
- **Weixin Chat Trigger**: Receives messages and attachments as n8n chat input with a persistent per-user session ID.
- **Chat command routing**: Requires one unique command per Chat Trigger and switches users between workflows while preserving each workflow's own conversation.
- **New conversation command**: Always enables `/new` and starts a fresh session for the currently selected Chat workflow.
- **Command isolation**: Keeps Chat commands and ordinary Trigger commands separate while requiring command names to be unique across both trigger types.
- **Weixin Chat**: Sends text replies, directly supplied images or PDFs, and supports Send and Wait for Response.
- **Weixin Trigger**: Runs configured slash commands without reacting to ordinary text or media messages.
- **Weixin node**: Sends or receives text, images, videos, and files.
- **Automatic context**: Resolves the Weixin context token from the current input or persistent inbox without a node field.
- **Agent media input**: Supports the n8n Agent's passthrough handling for images and configured PDF input.
- **User isolation**: Rejects messages and sends that do not match the credential-bound user ID.

## Installation

Install the package from **Settings → Community Nodes** or run `npm install n8n-nodes-openclaw-weixin` in the n8n community nodes directory.

## Setup

1. Add **OpenClaw Weixin Login Trigger** to a temporary workflow and open its test webhook URL.
2. Scan the QR code with Weixin and copy the returned `botToken`, `botId`, `baseUrl`, and `userId` into a **Weixin API** credential.
3. Disable saving manual executions for the login workflow because its output contains the bot token.
4. Select the credential in the Chat Trigger, ordinary Trigger, and sending nodes that use the account.
5. Set a different command on every Chat Trigger, such as `reading` or `cooking`, and send `/reading` or `/cooking` to select a workflow.
6. Connect the Chat Trigger to an Agent and the Agent output to **OpenClaw Weixin Chat** to send the response.

## Conversation behavior

- A Chat Trigger command switches the active workflow and replies with that command.
- Switching back to a command resumes that workflow's previous session.
- `/new` resets only the active workflow's session and replies with its command.
- A message without an active Chat workflow receives the available Chat commands one per line.
- An unknown slash command receives the available Chat commands without changing the active workflow.
- An ordinary Trigger command still runs its own workflow without changing or interrupting the Chat session.

## Limitations

- Queue mode and cross-process Send and Wait require shared state that this package does not provide.
- Agent output does not always preserve input binary data, so connect the relevant binary input directly to the Chat node when sending an image or PDF.
- The package does not implement n8n hosted Chat UI or Agent streaming conversion for Weixin.

## References

- [OpenClaw Weixin](https://github.com/Tencent/openclaw-weixin)
- [n8n Community Nodes](https://docs.n8n.io/integrations/community-nodes/)
- [n8n AI Agent](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.agent/)
- [OpenClaw Weixin integration research](../../references/n8n-openclaw-weixin-agent-integration_zh_CN.md)
