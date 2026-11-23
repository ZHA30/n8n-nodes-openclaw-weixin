import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import type { INodeType, INodeTypeDescription, ITriggerFunctions, ITriggerResponse } from 'n8n-workflow';
import { credentialName, sendTextMessage, type Account } from '../shared/api';
import { subscribe, type ChatMode } from '../shared/inbox';

export class WeixinChatTrigger implements INodeType {
	description: INodeTypeDescription = {
		icon: 'file:../../assets/icon.svg', displayName: 'OpenClaw Weixin Chat Trigger', subtitle: 'Weixin chat',
		name: 'weixinChatTrigger', group: ['trigger'], version: 1,
		description: 'Receive Weixin messages as n8n chat input. If userId is set on the credential, only that user is accepted. Avoid enabling another Weixin Trigger for the same messages unless duplicate workflow runs are intended.', defaults: { name: 'OpenClaw Weixin Chat Trigger' },
		inputs: [], outputs: [NodeConnectionTypes.Main], credentials: [{ name: credentialName, required: true }],
		properties: [
			{ displayName: 'Command', name: 'command', type: 'string', default: '', required: true, description: 'Unique command used to select this chat workflow, without the leading slash. The command "new" is reserved.' },
			{ displayName: 'Session Mode', name: 'sessionMode', type: 'options', default: 'persistent', options: [
				{ name: 'Persistent per User', value: 'persistent' }, { name: 'New Session per Message', value: 'perMessage' },
			] },
		],
	};

	async trigger(this: ITriggerFunctions): Promise<ITriggerResponse> {
		const account = await this.getCredentials<Account>(credentialName);
		const command = (this.getNodeParameter('command', '') as string).trim().replace(/^\//, '').toLowerCase();
		if (!/^[a-z0-9_-]+$/.test(command) || command === 'new') throw new NodeOperationError(this.getNode(), 'Command must contain only letters, numbers, underscores, or hyphens, and cannot be "new".');
		const mode = this.getNodeParameter('sessionMode', 'persistent') as ChatMode;
		try {
			const closeFunction = await subscribe(account, {
				event: 'all', manual: this.getMode() === 'manual', command, chat: { command, mode, newCommand: '/new' },
				emit: (json, binary) => this.emit([[{ json, binary }]]),
				reply: async (text, contextToken) => { await sendTextMessage(account, account.ownerUserId, text, contextToken); },
				prepareBinary: (data, fileName, mimeType) => this.helpers.prepareBinaryData(data, fileName, mimeType),
				error: (error) => this.emitError(new NodeOperationError(this.getNode(), error instanceof Error ? error : String(error))),
			});
			return { closeFunction };
		} catch (error) {
			throw new NodeOperationError(this.getNode(), error instanceof Error ? error : String(error));
		}
	}
}
