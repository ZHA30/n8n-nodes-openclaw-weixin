import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import type {
	INodeType,
	INodeTypeDescription,
	ITriggerFunctions,
	ITriggerResponse,
} from 'n8n-workflow';
import { credentialName, type Account } from '../shared/api';
import { subscribe } from '../shared/inbox';

export class WeixinTrigger implements INodeType {
	description: INodeTypeDescription = {
		icon: 'file:../../assets/icon.svg',
		subtitle: 'Direct message',
		displayName: 'OpenClaw Weixin Trigger',
		name: 'weixinTrigger',
		group: ['trigger'],
		version: 1,
		description: 'Trigger on Weixin slash commands',
		defaults: { name: 'OpenClaw Weixin Trigger' },
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: credentialName, required: true }],
		properties: [
			{
				displayName: 'Command',
				name: 'command',
				type: 'string',
				default: '',
				required: true,
				description: 'Command to match without the leading slash',
			},
		],
	};

	async trigger(this: ITriggerFunctions): Promise<ITriggerResponse> {
		const command = (this.getNodeParameter('command', '') as string).trim().toLowerCase();
		if (!/^[a-z0-9_-]+$/.test(command)) {
			throw new NodeOperationError(
				this.getNode(),
				'Command must contain only letters, numbers, underscores, or hyphens.',
			);
		}
		const account = await this.getCredentials<Account>(credentialName);
		try {
			const closeFunction = await subscribe(account, {
				event: 'command',
				command,
				manual: this.getMode() === 'manual',
				emit: (json) => this.emit([[{ json }]]),
				error: (error) =>
					this.emitError(
						new NodeOperationError(this.getNode(), error instanceof Error ? error : String(error)),
					),
			});
			return { closeFunction };
		} catch (error) {
			throw new NodeOperationError(this.getNode(), error instanceof Error ? error : String(error));
		}
	}
}
