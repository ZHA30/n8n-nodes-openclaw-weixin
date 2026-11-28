import type { ICredentialType, INodeProperties } from 'n8n-workflow';

export class WeixinApi implements ICredentialType {
	name = 'weixinApi';
	displayName = 'Weixin API';
	icon = 'file:../assets/icon.svg' as const;
	documentationUrl = 'https://github.com/ZHA30/n8n-nodes-openclaw-weixin';
	properties: INodeProperties[] = [
		{
			displayName: 'Bot Token',
			name: 'botToken',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
		},
		{ displayName: 'Bot ID', name: 'botId', type: 'string', default: '', required: true },
		{
			displayName: 'API Base URL',
			name: 'baseUrl',
			type: 'string',
			default: '',
		},
		{ displayName: 'Bound User ID', name: 'ownerUserId', type: 'string', default: '', required: true, description: 'Copy userId from the account binding output. This is the only user the credential can receive from or send to.' },
	];
}
