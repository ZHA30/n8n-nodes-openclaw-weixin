# n8n-nodes-openclaw-weixin

Connect self-hosted n8n workflows to Weixin direct messages through the OpenClaw iLink Bot API.

> [!NOTE]
> Run each bot on a single n8n main process with persistent storage and use the same credential for its triggers.

> [!WARNING]
> Disable saving manual executions for the login workflow because its output contains the bot token.

## Features

Install `n8n-nodes-openclaw-weixin` from n8n Community Nodes settings or with `npm install n8n-nodes-openclaw-weixin` in the community nodes directory.

- **OpenClaw Weixin Login Trigger** provides a QR login page at its test webhook URL and outputs the credential fields.
- **Weixin API credential** stores the returned `botToken`, `botId`, `baseUrl`, and `userId` for messaging workflows.
- **OpenClaw Weixin Trigger** receives all direct messages or filters text, commands, images, voice, video, and files.
- **Commands** match text such as `/weather Shanghai` and output `command` as `weather` and `args` as `Shanghai`.
- **OpenClaw Weixin** sends text, images, video, and files, and downloads received attachments to n8n binary data.
- **Send options** allow `toUserId` and `contextToken` to be supplied, with the credential's `userId` used as the default recipient.
- **Download Attachment** accepts the attachment `type`, `url` or `query`, and the `key` for encrypted media.
- **Binary data** uses the property `data` by default and can be configured under **Options**.

## References

- [OpenClaw Weixin](https://github.com/Tencent/openclaw-weixin)
- [n8n community node installation](https://docs.n8n.io/integrations/community-nodes/installation/manual-install/)
