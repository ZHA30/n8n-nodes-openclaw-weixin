import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import type { INodeType, INodeTypeDescription, ITriggerFunctions, ITriggerResponse } from 'n8n-workflow';
import { credentialName, type Account } from '../shared/api';
import { subscribe, type ChatMode } from '../shared/inbox';

export class WeixinChatTrigger implements INodeType {
	description: INodeTypeDescription = {
		icon: 'file:../../assets/icon.svg', displayName: 'OpenClaw Weixin Chat Trigger', subtitle: 'Weixin chat',
		name: 'weixinChatTrigger', group: ['trigger'], version: 1,
		description: 'Receive Weixin messages as n8n chat input. If userId is set on the credential, only that user is accepted. Avoid enabling another Weixin Trigger for the same messages unless duplicate workflow runs are intended.', defaults: { name: 'OpenClaw Weixin Chat Trigger' },
		inputs: [], outputs: [NodeConnectionTypes.Main], credentials: [{ name: credentialName, required: true }],
		properties: [
			{ displayName: 'Session Mode', name: 'sessionMode', type: 'options', default: 'persistent', options: [
				{ name: 'Persistent per User', value: 'persistent' }, { name: 'New Session per Message', value: 'perMessage' },
			] },
			{ displayName: 'Enable New Command', name: 'enableNewCommand', type: 'boolean', default: true, description: 'Whether /new starts a fresh Agent session' },
			{ displayName: 'Pass New Command to Agent', name: 'includeNewCommand', type: 'boolean', default: false, displayOptions: { show: { enableNewCommand: [true] } } },
		],
	};

	async trigger(this: ITriggerFunctions): Promise<ITriggerResponse> {
		const account = await this.getCredentials<Account>(credentialName);
		const mode = this.getNodeParameter('sessionMode', 'persistent') as ChatMode;
		const enableNewCommand = this.getNodeParameter('enableNewCommand', true) as boolean;
		const includeNewCommand = this.getNodeParameter('includeNewCommand', false) as boolean;
		try {
			const closeFunction = await subscribe(account, {
				event: 'all', manual: this.getMode() === 'manual', chat: { mode, newCommand: enableNewCommand ? '/new' : '', includeNewCommand },
				emit: (json, binary) => this.emit([[{ json, binary }]]),
				prepareBinary: (data, fileName, mimeType) => this.helpers.prepareBinaryData(data, fileName, mimeType),
				error: (error) => this.emitError(new NodeOperationError(this.getNode(), error instanceof Error ? error : String(error))),
			});
			return { closeFunction };
		} catch (error) {
			throw new NodeOperationError(this.getNode(), error instanceof Error ? error : String(error));
		}
	}
}
