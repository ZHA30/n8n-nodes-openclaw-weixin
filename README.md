# n8n-nodes-openclaw-weixin

n8n community nodes for connecting Weixin direct messages to workflows and AI Agent conversations through the OpenClaw iLink Bot API.

> [!NOTE]
> Each credential is bound to one Weixin `userId`, so create one credential per user and use the same n8n main process for polling and waiting executions.

> [!WARNING]
> Keep the credential and login workflow private because the bot token can access the Weixin account.

## Features

- **Weixin API credential**: Stores the bot token, bot ID, optional API base URL, and required bound user ID.
- **Weixin Login Trigger**: Provides a QR login flow and returns the credential values needed by the Weixin API credential.
- **Weixin Chat Trigger**: Receives regular Weixin messages as `chatInput`, stable per-user `sessionId`, metadata, and downloaded attachment binaries.
- **New conversation command**: Optionally treats the fixed `/new` command as a new Agent session and can hide it from the Agent input.
- **Weixin Chat**: Sends the final Agent text reply, supports Send and Wait for Response, and sends a directly supplied image or PDF binary after the text.
- **Weixin Trigger**: Runs only for configured slash commands and does not trigger on ordinary text or media messages.
- **Weixin node**: Sends text, images, videos, and files, or downloads an inbound attachment into n8n binary data.
- **Automatic context**: Selects the latest Weixin context token from the current input or the persistent inbox without exposing it as a node field.
- **Agent input media**: Works with n8n Agent passthrough for images and, when enabled in the Agent options, PDFs.
- **User isolation**: Rejects messages and sends that do not match the credential-bound user ID.

## Installation

Install the package from **Settings → Community Nodes** or run `npm install n8n-nodes-openclaw-weixin` in the n8n community nodes directory.

## Setup

1. Add **OpenClaw Weixin Login Trigger** to a test workflow and open its test webhook URL.
2. Scan the displayed QR code with Weixin and copy the returned `botToken`, `botId`, `baseUrl`, and `userId` into a **Weixin API** credential.
3. Disable saving manual executions for the login workflow because its output contains the bot token.
4. Select the same credential in the trigger and send nodes used by the workflow.

## References

- [OpenClaw Weixin](https://github.com/Tencent/openclaw-weixin)
- [n8n Community Nodes](https://docs.n8n.io/integrations/community-nodes/)
- [n8n AI Agent](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.agent/)
- [OpenClaw Weixin integration research](../../references/n8n-openclaw-weixin-agent-integration_zh_CN.md)
