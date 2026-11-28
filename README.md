# n8n-nodes-openclaw-weixin

n8n community nodes for receiving Weixin messages and connecting them to workflows and AI Agents through the Weixin iLink Bot API documented by openclaw-weixin.

> [!NOTE]
> Each Weixin API credential is bound to one `userId`, so create one credential for each user and use the same n8n main process for polling and waiting executions.

> [!WARNING]
> Keep the credential and login workflow private because the bot token can access the Weixin account.

## Features

- **Weixin API credential**: Stores the bot token, bot ID, optional API base URL, and required bound user ID.
- **Weixin Account Binding Trigger**: Starts a QR login flow and returns the values needed by the Weixin API credential.
- **Weixin Chat Trigger**: Receives messages and attachments as n8n chat input with a persistent per-user session ID.
- **Chat routing**: Each Bot can have one primary Chat Trigger or multiple Chat Triggers selected by unique commands.
- **New conversation command**: Send `/new` by itself to start a fresh session for the primary or selected Chat workflow.
- **Command isolation**: Keeps Chat commands and ordinary Trigger commands separate while requiring command names to be unique across both trigger types.
- **Weixin Reply**: Sends text replies, directly supplied images or PDFs, and supports Send and Wait for Response.
- **Weixin Command Trigger**: Runs configured slash commands without reacting to ordinary text or media messages.
- **Weixin node**: Sends or receives text, images, videos, and files.
- **Automatic context**: Resolves the Weixin context token from the current input or persistent inbox without a node field.
- **Agent media input**: Supports the n8n Agent's passthrough handling for images and configured PDF input.
- **User isolation**: Rejects messages and sends that do not match the credential-bound user ID.

## Installation

Install the package from **Settings → Community Nodes** or run `npm install n8n-nodes-openclaw-weixin` in the n8n community nodes directory.

## Setup

1. Create a temporary workflow, disable saving manual executions, and add **OpenClaw Weixin Account Binding Trigger**.
2. Open the node’s test webhook URL and scan the QR code with Weixin.
3. Copy the returned `botToken`, `botId`, `baseUrl`, and `userId` into the corresponding **Weixin API** fields.
4. Select the credential in the Chat Trigger, ordinary Trigger, and sending nodes that use the account.
5. Use **Primary Chat** for direct conversation with one workflow, or select **Select by Command** and assign a unique command to each Chat workflow.
6. Connect the Chat Trigger to an Agent and the Agent output to **OpenClaw Weixin Reply**, then set **Message** to `{{ $json.output }}` and **Reply To** to `{{ $('OpenClaw Weixin Chat Trigger').item.json }}` using the trigger’s actual name.

## Conversation behavior

- Existing version 1 triggers keep command-based routing, and version 2 triggers default to **Primary Chat**.
- In command mode, sending a Chat Trigger command switches the active workflow and replies with that command.
- Switching back to a command resumes that workflow's previous session.
- `/new` without arguments or attachments replies with “Started a new session” and routes the next message to the new session.
- The reset detaches the old session’s pending reply matcher, while its n8n execution waits until its configured timeout.
- In command mode, a message without an active Chat workflow receives the available Chat commands one per line.
- In command mode, an unknown slash command receives the available Chat commands without changing the active workflow.
- An ordinary Trigger command runs its own workflow and leaves the Chat session and any pending reply in place.
- Each Chat session can have one pending **Send and Wait for Response** operation, and the active session’s wait takes precedence over an account-wide wait.
- For **Chat Session** wait scope, map the original Chat Trigger item into **Reply To** when an upstream node replaces it.
- A manual listener alongside production workflows observes matching messages without selecting or resetting the production Chat session.
- A standalone manual listener uses the live inbox cursor and can consume unmatched messages.
- For on-demand media processing, disable **Download Attachments** on the Chat Trigger and map one object from `$json.attachments` into the Weixin node’s **Attachment** field.
- Bot API credentials support HTTPS endpoints under `weixin.qq.com`.

## Limitations

- **Send and Wait for Response** uses process-local reply matching, so use a regular workflow connection in the same n8n process as the trigger and keep that process running until the reply arrives.
- Consecutive messages in one Chat session can start overlapping Agent executions.
- Agent output does not always preserve input binary data, so connect the relevant binary input directly to the Chat node when sending an image or PDF.
- The package does not implement n8n hosted Chat UI or Agent streaming conversion for Weixin.

## References

- [OpenClaw Weixin](https://github.com/Tencent/openclaw-weixin)
- [n8n Community Nodes](https://docs.n8n.io/integrations/community-nodes/)
- [n8n AI Agent](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.agent/)
- [OpenClaw Weixin integration research](../../references/n8n-openclaw-weixin-agent-integration_zh_CN.md)
