# n8n-nodes-openclaw-weixin

Connect self-hosted n8n workflows to Weixin direct messages through the iLink Bot API used by OpenClaw.

> [!NOTE]
> Run one active Weixin Trigger per bot on a single n8n main process with a persistent data directory.

> [!WARNING]
> Disable saving manual executions for the binding workflow because its output contains the bot token.

## Features

Bind a bot by QR code, receive direct messages, reply with text or media, and download attachments.

- **Weixin Login Trigger** displays a QR code at the test webhook URL and outputs the Weixin API credential fields after confirmation.
- **Weixin Trigger** receives direct messages and attachment references while persisting the polling cursor across restarts.
- **Weixin** replies with text, images, videos, or files and downloads received attachments as n8n binary data.

## Setup

Install `n8n-nodes-openclaw-weixin` from the Community Nodes settings in self-hosted n8n, or run the following command from the instance's community nodes directory.

```sh
npm install n8n-nodes-openclaw-weixin
```

1. Start a test run of **Weixin Login Trigger**, open its **Test URL**, and confirm the QR login in Weixin.
2. Create a **Weixin API** credential with the returned `botToken`, `botId`, and `baseUrl`.
3. Activate **Weixin Trigger** and map the incoming `fromUserId` and `contextToken` into the **Weixin** reply operation.
4. For **Download Attachment**, map `type`, either `url` or `query`, and `key` when the media is encrypted.

Media operations use the binary property `data` by default, with overrides under **Options**.

## References

- [OpenClaw Weixin](https://github.com/Tencent/openclaw-weixin)
- [n8n community node installation](https://docs.n8n.io/integrations/community-nodes/installation/manual-install/)
