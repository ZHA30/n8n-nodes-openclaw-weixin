/* eslint-disable @n8n/community-nodes/webhook-lifecycle-complete */
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import type { INodeType, INodeTypeDescription, IExecuteFunctions, INodeExecutionData, IWebhookFunctions, IWebhookResponseData, IDataObject } from 'n8n-workflow';
import { credentialName, sendMessageItem, sendTextMessage, type Account } from '../shared/api';
import { uploadMedia } from '../shared/media';
import { getLatestContextToken, registerReplyWaiter } from '../shared/inbox';

export class WeixinChat implements INodeType {
	description: INodeTypeDescription = {
		usableAsTool: true, icon: 'file:../../assets/icon.svg', displayName: 'OpenClaw Weixin Chat', name: 'weixinChat',
		group: ['output'], version: 1, description: 'Reply to the current Weixin conversation, optionally pausing for the next message',
		subtitle: '={{ $parameter.operation === "sendAndWait" ? "Wait for reply" : "Send reply" }}',
		defaults: { name: 'OpenClaw Weixin Chat' }, inputs: [NodeConnectionTypes.Main], outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: credentialName, required: true }],
		webhooks: [{ name: 'default', httpMethod: 'POST', responseMode: 'onReceived', responseData: '', path: '={{ $nodeId }}', restartWebhook: true, isFullPath: true }],
		properties: [
			{ displayName: 'Operation', name: 'operation', type: 'options', noDataExpression: true, default: 'send', options: [{ name: 'Send Message', value: 'send' }, { name: 'Send and Wait for Response', value: 'sendAndWait' }] },
			{ displayName: 'Wait Timeout (Minutes)', name: 'waitTimeout', type: 'number', typeOptions: { minValue: 1, maxValue: 10080 }, default: 60, description: 'How long to wait for the bound user to reply. The next reply resumes the oldest pending wait.', displayOptions: { show: { operation: ['sendAndWait'] } } },
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
			const binaryEntry = Object.entries(input[i].binary ?? {})[0];
			const mime = binaryEntry?.[1].mimeType?.toLowerCase() ?? '';
			if (binaryEntry && mime !== 'application/pdf' && !mime.startsWith('image/'))
				throw new NodeOperationError(this.getNode(), 'Chat can send only image or PDF binary output. Use the Weixin node for other media.', { itemIndex: i });
			let unregister: (() => void) | undefined;
			let expiration: ReturnType<typeof setTimeout> | undefined;
			if (operation === 'sendAndWait') {
				const resumeUrl = this.getWorkflowDataProxy(i).$execution.resumeUrl;
				const removeWaiter = registerReplyWaiter(account.botId, toUserId, async (message) => {
					const response = await fetch(resumeUrl, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ data: message }),
					});
					if (!response.ok) throw new NodeOperationError(this.getNode(), `Weixin Chat wait resume failed (${response.status}).`);
					clearTimeout(expiration);
				});
				unregister = () => {
					clearTimeout(expiration);
					removeWaiter();
				};
				this.onExecutionFinish?.(unregister);
			}
			let response: { message_id?: string };
			try {
				const signal = this.getExecutionCancelSignal();
				const buffer = binaryEntry
					? await this.helpers.getBinaryDataBuffer(i, binaryEntry[0])
					: undefined;
				response = await sendTextMessage(account, toUserId, text, contextToken, signal);
				if (binaryEntry && buffer) {
					const [, binary] = binaryEntry;
					const mediaType = mime === 'application/pdf' ? 'file' : 'image';
					const item = await uploadMedia(account, mediaType, toUserId, buffer, binary.fileName || (mediaType === 'image' ? 'image.jpg' : 'document.pdf'), signal);
					await sendMessageItem(account, toUserId, item, contextToken, signal);
				}
				if (unregister) {
					const timeout = this.getNodeParameter('waitTimeout', i, 60) as number;
					const waitUntil = new Date(Date.now() + timeout * 60 * 1000);
					expiration = setTimeout(unregister, Math.max(0, waitUntil.getTime() - Date.now()));
					expiration.unref();
					await this.putExecutionToWait(waitUntil);
				}
			} catch (error) {
				unregister?.();
				throw error instanceof NodeOperationError
					? error
					: new NodeOperationError(this.getNode(), error instanceof Error ? error.message : String(error));
			}
			result.push({ json: { ...json, sent: true, messageId: response.message_id }, pairedItem: { item: i } });
		}
		return [result];
	}
}
