import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import type {
	INodeType,
	INodeTypeDescription,
	ITriggerFunctions,
	ITriggerResponse,
} from 'n8n-workflow';
import { credentialName, type Account } from '../shared/api';
import { subscribe, type EventType } from '../shared/inbox';

export class WeixinTrigger implements INodeType {
	description: INodeTypeDescription = {
		icon: 'file:../../assets/icon.svg',
		subtitle: 'Direct message',
		displayName: 'OpenClaw Weixin Trigger',
		name: 'weixinTrigger',
		group: ['trigger'],
		version: 1,
		description: 'Receive Weixin direct messages',
		defaults: { name: 'OpenClaw Weixin Trigger' },
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: credentialName, required: true }],
		properties: [
			{
				displayName: 'Event',
				name: 'event',
				type: 'options',
				default: 'all',
				options: [
					{ name: 'All Messages', value: 'all' },
					{ name: 'Command', value: 'command' },
					{ name: 'File', value: 'file' },
					{ name: 'Image', value: 'image' },
					{ name: 'Text', value: 'text' },
					{ name: 'Video', value: 'video' },
					{ name: 'Voice', value: 'voice' },
				],
			},
			{
				displayName: 'Command',
				name: 'command',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { event: ['command'] } },
				description: 'Command to match without the leading slash',
			},
			{
				displayName: 'Exclude Commands',
				name: 'excludeCommands',
				type: 'boolean',
				default: false,
				displayOptions: { show: { event: ['text'] } },
				description: 'Whether to exclude text messages starting with a slash command',
			},
		],
	};

	async trigger(this: ITriggerFunctions): Promise<ITriggerResponse> {
		const event = this.getNodeParameter('event', 'all') as EventType;
		const command =
			event === 'command'
				? (this.getNodeParameter('command', '') as string).trim().toLowerCase()
				: undefined;
		if (event === 'command' && !/^[a-z0-9_-]+$/.test(command ?? '')) {
			throw new NodeOperationError(
				this.getNode(),
				'Command must contain only letters, numbers, underscores, or hyphens.',
			);
		}
		const account = await this.getCredentials<Account>(credentialName);
		try {
			const closeFunction = await subscribe(account, {
				event,
				command,
				excludeCommands:
					event === 'text' && (this.getNodeParameter('excludeCommands', false) as boolean),
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
