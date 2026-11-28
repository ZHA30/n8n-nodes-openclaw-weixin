/* eslint-disable @n8n/community-nodes/webhook-lifecycle-complete */
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import type { INodeType, INodeTypeDescription, IExecuteFunctions, INodeExecutionData, IWebhookFunctions, IWebhookResponseData, IDataObject } from 'n8n-workflow';
import { credentialName, sendMessageItem, sendTextMessage, type Account } from '../shared/api';
import { uploadMedia } from '../shared/media';
import { assertCurrentChatSession, getLatestContextToken, registerReplyWaiter } from '../shared/inbox';

export class WeixinChat implements INodeType {
	description: INodeTypeDescription = {
		usableAsTool: true, icon: 'file:../../assets/icon.svg', displayName: 'OpenClaw Weixin Reply', name: 'weixinChat',
		group: ['output'], version: 1, description: 'Reply to the current Weixin conversation, optionally pausing for the next message',
		subtitle: '={{ $parameter.operation === "sendAndWait" ? "Wait for reply" : "Send reply" }}',
		defaults: { name: 'OpenClaw Weixin Chat' }, inputs: [NodeConnectionTypes.Main], outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: credentialName, required: true }],
		webhooks: [{ name: 'default', httpMethod: 'POST', responseMode: 'onReceived', responseData: '', path: '={{ $nodeId }}', restartWebhook: true, isFullPath: true }],
		properties: [
			{ displayName: 'Operation', name: 'operation', type: 'options', noDataExpression: true, default: 'send', options: [{ name: 'Send Message', value: 'send' }, { name: 'Send and Wait for Response', value: 'sendAndWait' }] },
			{ displayName: 'Wait Timeout (Minutes)', name: 'waitTimeout', type: 'number', typeOptions: { minValue: 1, maxValue: 10080 }, default: 60, description: 'How long to wait for the bound user to reply. Only one wait may be active per conversation.', displayOptions: { show: { operation: ['sendAndWait'] } } },
			{ displayName: 'Wait Scope', name: 'waitScope', type: 'options', default: 'auto', displayOptions: { show: { operation: ['sendAndWait'] } }, options: [
				{ name: 'Automatic', value: 'auto', description: 'Use the source chat session when available or wait for any conversation on this account' },
				{ name: 'Chat Session', value: 'session', description: 'Require the original Chat Trigger event and match replies in that session' },
				{ name: 'Account', value: 'account', description: 'Match replies across conversations when the active chat session has no pending wait' },
			] },
			{ displayName: 'Binary Field', name: 'binaryField', type: 'string', default: '', description: 'Binary property to send as an image or PDF. Leave empty to use the first available property.' },
			{ displayName: 'Reply To', name: 'replyTo', type: 'json', default: '', description: 'Optional original Weixin Trigger item to identify the conversation after an Agent or another node changes the input' },
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
			const replyTo = this.getNodeParameter('replyTo', i, '');
			let source: unknown = replyTo || json;
			try {
				if (typeof source === 'string') source = JSON.parse(source);
			} catch {
				throw new NodeOperationError(this.getNode(), 'Reply To must contain valid JSON.', { itemIndex: i });
			}
			if (!source || typeof source !== 'object' || Array.isArray(source))
				throw new NodeOperationError(this.getNode(), 'Reply To must be a Weixin event object.', { itemIndex: i });
			const event = source as Record<string, unknown>;
			if (event.botId && event.botId !== account.botId.trim())
				throw new NodeOperationError(this.getNode(), 'Reply event Bot ID must match the Weixin credential.', { itemIndex: i });
			const inputUserId = String(event.fromUserId || '');
			if (inputUserId && inputUserId !== boundUserId)
				throw new NodeOperationError(this.getNode(), 'Input fromUserId must match the userId in the Weixin credential.', { itemIndex: i });
			const toUserId = boundUserId;
			const contextToken = ((toUserId === inputUserId ? event.contextToken : undefined) || await getLatestContextToken(account.botId, toUserId) || '').toString();
			const operation = this.getNodeParameter('operation', i, 'send') as string;
			if (!toUserId) throw new NodeOperationError(this.getNode(), 'No Weixin recipient is available.', { itemIndex: i });
			if (!text.trim()) throw new NodeOperationError(this.getNode(), 'Message is required.', { itemIndex: i });
			if (!contextToken) throw new NodeOperationError(this.getNode(), 'No Weixin context token is available for this user. Ensure the Chat Trigger received a message with a context token and shares its n8n user folder with this execution.', { itemIndex: i });
			const binaryField = (this.getNodeParameter('binaryField', i, '') as string).trim();
			const binaryEntry = Object.entries(input[i].binary ?? {}).find(([name]) => !binaryField || name === binaryField);
			if (binaryField && !binaryEntry)
				throw new NodeOperationError(this.getNode(), `Binary field "${binaryField}" is missing.`, { itemIndex: i });
			const mime = binaryEntry?.[1].mimeType?.toLowerCase() ?? '';
			if (binaryEntry && mime !== 'application/pdf' && !mime.startsWith('image/'))
				throw new NodeOperationError(this.getNode(), 'Chat can send only image or PDF binary output. Use the Weixin node for other media.', { itemIndex: i });
			let unregister: (() => void) | undefined;
			let waitUntil: Date | undefined;
			let markReady: ((ready: boolean) => void) | undefined;
			const clientMessageId = randomUUID();
			let attachmentClientMessageId: ReturnType<typeof randomUUID> | undefined;
			let response: { message_id?: string } | undefined;
			try {
				if (operation === 'sendAndWait') {
					const minutes = this.getNodeParameter('waitTimeout', i, 60) as number;
					if (!Number.isFinite(minutes) || minutes < 1 || minutes > 10080)
						throw new NodeOperationError(this.getNode(), 'Wait timeout must be between 1 and 10080 minutes.', { itemIndex: i });
					const sessionData = event.weixinSession;
					const scope = this.getNodeParameter('waitScope', i, 'auto');
					const session = scope !== 'account' && sessionData && typeof sessionData === 'object' &&
						'key' in sessionData && typeof sessionData.key === 'string' &&
						'generation' in sessionData && typeof sessionData.generation === 'number'
						? { key: sessionData.key, generation: sessionData.generation }
						: undefined;
					if (scope === 'session' && !session)
						throw new NodeOperationError(this.getNode(), 'Chat Session waits require the original Chat Trigger event in Reply To or the input.', { itemIndex: i });
					if (session) await assertCurrentChatSession(account.botId, session);
					const resumeUrl = this.getWorkflowDataProxy(i).$execution.resumeUrl;
					const ready = new Promise<boolean>((resolve) => { markReady = resolve; });
					const controller = new AbortController();
					const removeWaiter = registerReplyWaiter(account.botId, toUserId, async (message) => {
						if (!await ready || controller.signal.aborted) return;
						// The host persists the waiting execution after the node returns.
						let backoff = 250;
						while (!controller.signal.aborted) {
							let response: Response | undefined;
							try {
								response = await fetch(resumeUrl, {
									method: 'POST',
									headers: { 'content-type': 'application/json' },
									body: JSON.stringify({ data: message }),
									redirect: 'error',
									signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
								});
								await response.body?.cancel().catch(() => undefined);
							} catch {
								if (controller.signal.aborted) return;
							}
							if (response?.ok) {
								unregister?.();
								return;
							}
							if (response && response.status !== 409 && response.status !== 429 && response.status < 500)
								throw new NodeOperationError(this.getNode(), `Weixin Chat wait resume failed (${response.status}).`, { itemIndex: i });
							try {
								await delay(backoff, undefined, { signal: controller.signal });
							} catch (error) {
								if (controller.signal.aborted) return;
								throw new NodeOperationError(this.getNode(), error instanceof Error ? error.message : String(error), { itemIndex: i });
							}
							backoff = Math.min(backoff * 2, 5000);
						}
					}, session, () => unregister?.());
					waitUntil = new Date(Date.now() + minutes * 60_000);
					const expiration = setTimeout(() => unregister?.(), waitUntil.getTime() - Date.now());
					expiration.unref();
					unregister = () => {
						clearTimeout(expiration);
						markReady?.(false);
						removeWaiter();
						controller.abort();
					};
					this.onExecutionFinish?.(unregister);
				}
				const signal = this.getExecutionCancelSignal();
				const buffer = binaryEntry
					? await this.helpers.getBinaryDataBuffer(i, binaryEntry[0])
					: undefined;
				let item;
				if (binaryEntry && buffer) {
					const [, binary] = binaryEntry;
					const mediaType = mime === 'application/pdf' ? 'file' : 'image';
					item = await uploadMedia(account, mediaType, toUserId, buffer, binary.fileName || (mediaType === 'image' ? 'image.jpg' : 'document.pdf'), signal);
				}
				response = await sendTextMessage(account, toUserId, text, contextToken, signal, clientMessageId);
				if (item) {
					attachmentClientMessageId = randomUUID();
					await sendMessageItem(account, toUserId, item, contextToken, signal, attachmentClientMessageId);
				}
				if (waitUntil) {
					await this.putExecutionToWait(waitUntil);
					markReady?.(true);
				}
			} catch (error) {
				unregister?.();
				const message = error instanceof Error ? error.message : String(error);
				const failure = response
					? new NodeOperationError(this.getNode(), 'Weixin accepted the text before a later step failed.', {
						itemIndex: i,
						description: `Client message ID: ${clientMessageId}. ${message}`,
					})
					: error instanceof NodeOperationError
						? error
						: new NodeOperationError(this.getNode(), message, { itemIndex: i });
				if (!this.continueOnFail?.()) throw failure;
				result.push({
					json: { error: failure.message, ...(response ? { clientMessageId, messageId: response.message_id } : {}) },
					error: failure,
					pairedItem: { item: i },
				});
				continue;
			}
			result.push({ json: { ...json, sent: true, clientMessageId, messageId: response.message_id, ...(attachmentClientMessageId ? { attachmentClientMessageId } : {}) }, pairedItem: { item: i } });
		}
		return [result];
	}
}
