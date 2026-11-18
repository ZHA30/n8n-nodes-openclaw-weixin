import { randomUUID } from 'node:crypto';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import type {
	IExecuteFunctions,
	INodeProperties,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { botRequest, credentialName, type Account } from '../shared/api';
import { downloadMedia, uploadMedia, type Attachment } from '../shared/media';

const downloadOnly: INodeProperties['displayOptions'] = { show: { operation: ['download'] } };

const attachmentFields = ['type', 'url', 'query', 'key'] as const;
const attachmentDescriptions = {
	type: 'The attachment type from the trigger. Use image, video, voice, or file.',
	url: 'The full download URL from the attachment. Leave empty to use query.',
	query: 'The encrypted download parameter from the attachment. Used when url is empty.',
	key: 'The decryption key from the attachment. Required for encrypted media.',
};
const binaryPropertyOption: INodeProperties = {
	displayName: 'binaryProperty',
	name: 'binaryProperty',
	type: 'string',
	default: 'data',
};

const sendOptions: INodeProperties[] = [
	{
		displayName: 'contextToken',
		name: 'contextToken',
		type: 'string',
		typeOptions: { password: true },
		default: '',
		description: 'Conversation context from a received message',
	},
	{
		displayName: 'toUserId',
		name: 'toUserId',
		type: 'string',
		default: '',
		description: 'Recipient ID. Defaults to userId from the credential.',
	},
];

export class Weixin implements INodeType {
	description: INodeTypeDescription = {
		icon: 'file:../../assets/icon.svg',
		subtitle: '={{ $parameter.operation }}',
		displayName: 'OpenClaw Weixin',
		name: 'weixin',
		group: ['output'],
		version: 1,
		description: 'Send Weixin messages and download attachments',
		defaults: { name: 'OpenClaw Weixin' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: credentialName, required: true }],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				description: 'Choose how to send a message or download an attachment',
				default: 'text',
				options: [
					{ name: 'Download Attachment', value: 'download', action: 'Download an attachment' },
					{ name: 'Send File', value: 'file', action: 'Send a file' },
					{ name: 'Send Image', value: 'image', action: 'Send an image' },
					{ name: 'Send Text', value: 'text', action: 'Send a text message' },
					{ name: 'Send Video', value: 'video', action: 'Send a video' },
				],
			},
			...attachmentFields.map(
				(name): INodeProperties => ({
					displayName: name,
					description: attachmentDescriptions[name],
					name,
					type: 'string',
					default: '',
					required: name === 'type',
					displayOptions: downloadOnly,
					...(name === 'key' ? { typeOptions: { password: true } } : {}),
				}),
			),
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				default: {},
				placeholder: 'Add Option',
				displayOptions: downloadOnly,
				options: [
					{
						...binaryPropertyOption,
						description: 'The output binary property for the downloaded file. Defaults to data.',
					},
					{
						displayName: 'fileName',
						name: 'fileName',
						type: 'string',
						default: '',
						description: 'The file name to assign to the downloaded binary',
					},
				],
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				default: {},
				placeholder: 'Add Option',
				displayOptions: { show: { operation: ['text'] } },
				options: sendOptions,
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				default: {},
				placeholder: 'Add Option',
				displayOptions: { show: { operation: ['file', 'image', 'video'] } },
				options: [
					{
						...binaryPropertyOption,
						description: 'The input binary property containing the file to send. Defaults to data.',
					},
					...sendOptions,
				],
			},
			{
				// eslint-disable-next-line n8n-nodes-base/node-param-display-name-miscased
				displayName: 'text',
				displayOptions: { show: { operation: ['text'] } },
				name: 'text',
				description: 'The message text to send',
				type: 'string',
				typeOptions: { rows: 4 },
				default: '',
				required: true,
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const operation = (this.getNodeParameter('operation', 0, 'text') || 'text') as
			| 'text'
			| 'download'
			| 'image'
			| 'video'
			| 'file';
		const account =
			operation === 'download' ? undefined : await this.getCredentials<Account>(credentialName);
		const signal = this.getExecutionCancelSignal();
		const input = this.getInputData();
		const output: INodeExecutionData[] = [];
		for (let i = 0; i < input.length; i++) {
			const pairedItem = { item: i };
			try {
				const options = this.getNodeParameter('options', i, {}) as {
					binaryProperty?: string;
					fileName?: string;
					toUserId?: string;
					contextToken?: string;
				};
				const property = options.binaryProperty?.trim() || 'data';
				if (operation === 'download') {
					const attachment = Object.fromEntries(
						attachmentFields.map((name) => [name, this.getNodeParameter(name, i, '')]),
					) as Attachment;
					attachment.fileName = options.fileName;
					const { data, fileName } = await downloadMedia(attachment, signal);
					const binary = await this.helpers.prepareBinaryData(
						data,
						fileName,
						attachment.type === 'voice' ? 'audio/silk' : undefined,
					);
					output.push({
						json: input[i].json,
						binary: { ...input[i].binary, [property]: binary },
						pairedItem,
					});
					continue;
				}
				const to = options.toUserId?.trim() || account!.ownerUserId?.trim();
				if (!to) {
					throw new NodeOperationError(
						this.getNode(),
						'Provide toUserId or set userId in the credential.',
						{ itemIndex: i },
					);
				}
				const context = options.contextToken?.trim();
				let item;
				if (operation === 'text') {
					const text = this.getNodeParameter('text', i) as string;
					if (!text?.trim())
						throw new NodeOperationError(this.getNode(), 'Text is required.', { itemIndex: i });
					item = { type: 1, text_item: { text } };
				} else {
					const binary = this.helpers.assertBinaryData(i, property);
					const buffer = await this.helpers.getBinaryDataBuffer(i, property);
					item = await uploadMedia(
						account!,
						operation,
						to,
						buffer,
						binary.fileName || 'attachment.bin',
						signal,
					);
				}
				const clientMessageId = randomUUID();
				const result = await botRequest<{ message_id?: string }>(
					account!,
					'sendmessage',
					{
						msg: {
							from_user_id: '',
							to_user_id: to,
							context_token: context || undefined,
							client_id: clientMessageId,
							message_type: 2,
							message_state: 2,
							item_list: [item],
						},
					},
					signal,
				);
				output.push({ json: { clientMessageId, messageId: result.message_id }, pairedItem });
			} catch (error) {
				const failure = new NodeOperationError(
					this.getNode(),
					error instanceof Error ? error : String(error),
					{ itemIndex: i },
				);
				if (!this.continueOnFail()) throw failure;
				output.push({ json: { error: failure.message }, error: failure, pairedItem });
			}
		}
		return [output];
	}
}
