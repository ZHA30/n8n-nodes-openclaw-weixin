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
		subtitle: '={{ "/" + $parameter.command.replace(/^\\//, "") }}',
		displayName: 'OpenClaw Weixin Command Trigger',
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
				description: 'Command to match, with or without the leading slash',
			},
		],
	};

	async trigger(this: ITriggerFunctions): Promise<ITriggerResponse> {
		const command = (this.getNodeParameter('command', '') as string).trim().replace(/^\//, '').toLowerCase();
		if (!/^[a-z0-9_-]+$/.test(command) || command === 'new') {
			throw new NodeOperationError(
				this.getNode(),
				'Command must contain only letters, numbers, underscores, or hyphens, and cannot be "new".',
			);
		}
		const account = await this.getCredentials<Account>(credentialName);
		try {
			const closeFunction = await subscribe(account, {
				event: 'command',
				command,
				manual: this.getMode() === 'manual',
				emit: (json) => this.emit([[{ json }]]),
				messageError: (error) => {
					const failure = new NodeOperationError(this.getNode(), error instanceof Error ? error.message : String(error));
					if (this.getMode() !== 'manual' && this.saveFailedExecution) this.saveFailedExecution(failure);
					else this.logger.warn(failure.message);
				},
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
