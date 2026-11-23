/* eslint-disable @n8n/community-nodes/webhook-lifecycle-complete */
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import type { INodeType, INodeTypeDescription, IExecuteFunctions, INodeExecutionData, IWebhookFunctions, IWebhookResponseData, IDataObject } from 'n8n-workflow';
import { credentialName, sendMessageItem, sendTextMessage, type Account } from '../shared/api';
import { uploadMedia } from '../shared/media';
import { getLatestContextToken, registerReplyWaiter } from '../shared/inbox';

export class WeixinChat implements INodeType {
	description: INodeTypeDescription = {
		usableAsTool: true, icon: 'file:../../assets/icon.svg', displayName: 'OpenClaw Weixin Chat', name: 'weixinChat',
		group: ['output'], version: 1, description: 'Send a message to the current Weixin chat. Send and Wait resumes the first pending wait for this user; avoid concurrent waits for the same user.',
		subtitle: 'Send message',
		defaults: { name: 'OpenClaw Weixin Chat' }, inputs: [NodeConnectionTypes.Main], outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: credentialName, required: true }],
		webhooks: [{ name: 'default', httpMethod: 'POST', responseMode: 'onReceived', responseData: '', path: '={{ $nodeId }}', restartWebhook: true, isFullPath: true }],
		properties: [
			{ displayName: 'Operation', name: 'operation', type: 'options', noDataExpression: true, default: 'send', options: [{ name: 'Send Message', value: 'send' }, { name: 'Send and Wait for Response', value: 'sendAndWait' }] },
			{ displayName: 'Wait Timeout (Minutes)', name: 'waitTimeout', type: 'number', typeOptions: { minValue: 1, maxValue: 10080 }, default: 60, displayOptions: { show: { operation: ['sendAndWait'] } } },
			{ displayName: 'Message', name: 'text', type: 'string', typeOptions: { rows: 4 }, default: '', required: true },
		],
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const body = this.getBodyData();
		return { workflowData: [[{ json: (body.data && typeof body.data === 'object' ? body.data : body) as IDataObject }]] };
	}

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const input = this.getInputData();
		if (this.getNodeParameter('operation', 0, 'send') === 'sendAndWait' && input.length > 1)
			throw new NodeOperationError(this.getNode(), 'Send and Wait supports one input item per execution.');
		const account = await this.getCredentials<Account>(credentialName);
		const result: INodeExecutionData[] = [];
		for (let i = 0; i < input.length; i++) {
			const json = input[i].json as Record<string, unknown>;
			const text = this.getNodeParameter('text', i) as string;
			const boundUserId = account.ownerUserId?.trim();
			if (!boundUserId) throw new NodeOperationError(this.getNode(), 'userId is required in the Weixin credential.', { itemIndex: i });
			const inputUserId = String(json.fromUserId || '');
			if (inputUserId && inputUserId !== boundUserId)
				throw new NodeOperationError(this.getNode(), 'Input fromUserId must match the userId in the Weixin credential.', { itemIndex: i });
			const toUserId = boundUserId;
			const contextToken = ((toUserId === inputUserId ? json.contextToken : undefined) || await getLatestContextToken(account.botId, toUserId) || '').toString();
			const operation = this.getNodeParameter('operation', i, 'send') as string;
			if (!toUserId) throw new NodeOperationError(this.getNode(), 'No Weixin recipient is available.', { itemIndex: i });
			if (!text.trim()) throw new NodeOperationError(this.getNode(), 'Message is required.', { itemIndex: i });
			if (!contextToken) throw new NodeOperationError(this.getNode(), 'No Weixin context token is available for this user. Ensure the Chat Trigger received a message with a context token and shares its n8n user folder with this execution.', { itemIndex: i });
			let unregister: (() => void) | undefined;
			if (operation === 'sendAndWait') {
				const resumeUrl = this.getWorkflowDataProxy(i).$execution.resumeUrl;
				unregister = registerReplyWaiter(account.botId, toUserId, async (message) => {
					const response = await fetch(resumeUrl, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ data: message }),
					});
					if (!response.ok) throw new NodeOperationError(this.getNode(), `Weixin Chat wait resume failed (${response.status}).`);
				});
				this.onExecutionFinish?.(() => unregister?.());
			}
			let response: { message_id?: string };
			try {
				const signal = this.getExecutionCancelSignal();
				response = await sendTextMessage(account, toUserId, text, contextToken, signal);
				const binaryEntries = Object.entries(input[i].binary ?? {});
				if (binaryEntries.length > 0) {
					const [property, binary] = binaryEntries[0];
					const mime = binary.mimeType?.toLowerCase() ?? '';
					if (mime !== 'application/pdf' && !mime.startsWith('image/'))
						throw new NodeOperationError(this.getNode(), 'Chat can send only image or PDF binary output. Use the Weixin node for other media.', { itemIndex: i });
					const mediaType = mime === 'application/pdf' ? 'file' : 'image';
					const buffer = await this.helpers.getBinaryDataBuffer(i, property);
					const item = await uploadMedia(account, mediaType, toUserId, buffer, binary.fileName || (mediaType === 'image' ? 'image.jpg' : 'document.pdf'), signal);
					await sendMessageItem(account, toUserId, item, contextToken, signal);
				}
			} catch (error) {
				unregister?.();
				throw error instanceof NodeOperationError
					? error
					: new NodeOperationError(this.getNode(), error instanceof Error ? error.message : String(error));
			}
			result.push({ json: { ...json, sent: true, messageId: response.message_id }, pairedItem: { item: i } });
			if (operation === 'sendAndWait') {
				const timeout = this.getNodeParameter('waitTimeout', i, 60) as number;
				await this.putExecutionToWait(new Date(Date.now() + timeout * 60 * 1000));
			}
		}
		return [result];
	}
}
