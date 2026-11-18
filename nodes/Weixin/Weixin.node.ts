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

const sendOnly: INodeProperties['displayOptions'] = { hide: { operation: ['', 'download'] } };
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

export class Weixin implements INodeType {
	description: INodeTypeDescription = {
		icon: 'file:../../assets/icon.svg',
		subtitle: '={{ $parameter.operation }}',
		displayName: 'Weixin',
		name: 'weixin',
		group: ['output'],
		version: 1,
		description: 'Send Weixin messages and download attachments',
		defaults: { name: 'Weixin' },
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
				displayOptions: { show: { operation: ['file', 'image', 'video'] } },
				options: [
					{
						...binaryPropertyOption,
						description: 'The input binary property containing the file to send. Defaults to data.',
					},
				],
			},
			{
				displayName: 'fromUserId',
				displayOptions: sendOnly,
				name: 'recipient',
				description: 'Map fromUserId from the incoming message to reply to its sender',
				type: 'string',
				default: '',
				required: true,
			},
			{
				displayName: 'contextToken',
				displayOptions: sendOnly,
				name: 'contextToken',
				description: 'Map contextToken from the incoming message to reply in the same conversation',
				type: 'string',
				typeOptions: { password: true },
				default: '',
				required: true,
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
				};
				const property =
					options.binaryProperty?.trim() ||
					(this.getNodeParameter('binaryProperty', i, '') as string).trim() ||
					'data';
				if (operation === 'download') {
					const parameters = this.getNode().parameters;
					const legacy =
						parameters.attachment !== undefined &&
						!attachmentFields.some((name) => parameters[name] !== undefined);
					let attachment: Attachment;
					if (legacy) {
						const value = this.getNodeParameter('attachment', i);
						attachment = (typeof value === 'string' ? JSON.parse(value) : value) as Attachment;
					} else {
						attachment = Object.fromEntries(
							attachmentFields.map((name) => [name, this.getNodeParameter(name, i, '')]),
						) as Attachment;
						attachment.fileName =
							options.fileName ?? (this.getNodeParameter('fileName', i, '') as string);
					}
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
				const to = this.getNodeParameter('recipient', i) as string;
				const context = this.getNodeParameter('contextToken', i) as string;
				if (!to?.trim() || !context?.trim()) {
					throw new NodeOperationError(
						this.getNode(),
						'Recipient and context token are required.',
						{ itemIndex: i },
					);
				}
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
							context_token: context,
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
