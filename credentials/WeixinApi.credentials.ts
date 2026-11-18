import type { ICredentialType, INodeProperties } from 'n8n-workflow';

export class WeixinApi implements ICredentialType {
	name = 'weixinApi';
	displayName = 'Weixin API';
	icon = 'file:../assets/icon.svg' as const;
	documentationUrl = 'https://github.com/ZHA30/n8n-nodes-openclaw-weixin';
	properties: INodeProperties[] = [
		{
			displayName: 'botToken',
			name: 'botToken',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
		},
		{ displayName: 'botId', name: 'botId', type: 'string', default: '', required: true },
		{
			displayName: 'baseUrl',
			name: 'baseUrl',
			type: 'string',
			default: '',
		},
		{ displayName: 'userId', name: 'ownerUserId', type: 'string', default: '' },
	];
}
