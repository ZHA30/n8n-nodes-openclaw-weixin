import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import type { INodeType, INodeTypeDescription, ITriggerFunctions, ITriggerResponse } from 'n8n-workflow';
import { credentialName, sendTextMessage, type Account } from '../shared/api';
import { subscribe, type ChatMode } from '../shared/inbox';

export class WeixinChatTrigger implements INodeType {
	description: INodeTypeDescription = {
		icon: 'file:../../assets/icon.svg', displayName: 'OpenClaw Weixin Chat Trigger', subtitle: 'Weixin chat',
		name: 'weixinChatTrigger', group: ['trigger'], version: [1, 2], defaultVersion: 2,
		description: 'Receive Weixin messages as n8n chat input. Receive chat input from the user bound to the credential.', defaults: { name: 'OpenClaw Weixin Chat Trigger' },
		inputs: [], outputs: [NodeConnectionTypes.Main], credentials: [{ name: credentialName, required: true }],
		properties: [
			{ displayName: 'Routing', name: 'routing', type: 'options', default: 'primary', displayOptions: { show: { '@version': [2] } }, options: [
				{ name: 'Primary Chat', value: 'primary', description: 'Receive messages directly as the primary chat for this Bot' },
				{ name: 'Select by Command', value: 'command', description: 'Receive messages after the user selects this workflow with a command' },
			] },
			{ displayName: 'Command', name: 'command', type: 'string', displayOptions: { show: { '@version': [1] } }, default: '', required: true, description: 'Unique command used to select this chat workflow, without the leading slash. The command "new" is reserved.' },
			{ displayName: 'Command', name: 'command', type: 'string', displayOptions: { show: { '@version': [2], routing: ['command'] } }, default: '', required: true, description: 'Unique command used to select this chat workflow, without the leading slash. The command "new" is reserved.' },
			{ displayName: 'Session Mode', name: 'sessionMode', type: 'options', default: 'persistent', options: [
				{ name: 'Persistent per User', value: 'persistent', description: 'Share conversation history until the user sends /new' }, { name: 'New Session per Message', value: 'perMessage', description: 'Give each message its own history. /new still clears pending replies.' },
			] },
			{ displayName: 'Download Attachments', name: 'downloadAttachments', type: 'boolean', default: true, description: 'Whether to include attachment binary data. Attachment metadata is always available.' },
		],
	};

	async trigger(this: ITriggerFunctions): Promise<ITriggerResponse> {
		const account = await this.getCredentials<Account>(credentialName);
		const primary = this.getNode().typeVersion >= 2 && this.getNodeParameter('routing', 'primary') === 'primary';
		const command = primary ? undefined : (this.getNodeParameter('command', '') as string).trim().replace(/^\//, '').toLowerCase();
		if (!primary && (!command || !/^[a-z0-9_-]+$/.test(command) || command === 'new')) throw new NodeOperationError(this.getNode(), 'Command must contain only letters, numbers, underscores, or hyphens, and cannot be "new".');
		const mode = this.getNodeParameter('sessionMode', 'persistent') as ChatMode;
		try {
			const closeFunction = await subscribe(account, {
				event: 'all', manual: this.getMode() === 'manual', command, chat: { command, mode, key: command ?? `workflow:${this.getWorkflow().id}` },
				emit: (json, binary) => this.emit([[{ json, binary }]]),
				reply: async (text, contextToken) => { await sendTextMessage(account, account.ownerUserId.trim(), text, contextToken); },
				prepareBinary: this.getNodeParameter('downloadAttachments', true)
					? (data, fileName, mimeType) => this.helpers.prepareBinaryData(data, fileName, mimeType)
					: undefined,
				messageError: (error) => {
					const failure = new NodeOperationError(this.getNode(), error instanceof Error ? error.message : String(error));
					if (this.getMode() !== 'manual' && this.saveFailedExecution) this.saveFailedExecution(failure);
					else this.logger.warn(failure.message);
				},
				error: (error) => this.emitError(new NodeOperationError(this.getNode(), error instanceof Error ? error : String(error))),
			});
			return { closeFunction };
		} catch (error) {
			throw new NodeOperationError(this.getNode(), error instanceof Error ? error : String(error));
		}
	}
}
