import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import type {
	INodeType,
	INodeTypeDescription,
	ITriggerFunctions,
	ITriggerResponse,
} from 'n8n-workflow';
import { botRequest, credentialName, WeixinError, type Account } from '../shared/api';

import { attachment, type MessageItem } from '../shared/media';

interface Message {
	message_id?: string;
	from_user_id?: string;
	group_id?: string;
	message_type?: number;
	create_time_ms?: number;
	context_token?: string;
	item_list?: MessageItem[];
}
interface Inbox {
	cursor: string;
	pending: Message[];
	recent: string[];
}
const active = new Set<string>();

function key(message: Message) {
	return message.message_id
		? JSON.stringify([message.from_user_id, message.message_id])
		: undefined;
}

export class WeixinTrigger implements INodeType {
	description: INodeTypeDescription = {
		icon: 'file:../../assets/icon.svg',
		subtitle: 'Direct message',
		displayName: 'Weixin Trigger',
		name: 'weixinTrigger',
		group: ['trigger'],
		version: 1,
		description: 'Receive Weixin direct messages',
		defaults: { name: 'Weixin Trigger' },
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: credentialName, required: true }],
		properties: [],
	};

	async trigger(this: ITriggerFunctions): Promise<ITriggerResponse> {
		if (this.getMode() === 'manual') {
			return {
				manualTriggerFunction: async () => {
					this.emit([
						[
							{
								json: {
									messageId: 'sample',
									botId: 'sample',
									fromUserId: 'sample@im.wechat',
									timestamp: Date.now(),
									text: 'Hello from Weixin',
									contextToken: '',
									attachments: [],
								},
							},
						],
					]);
				},
			};
		}

		const account = await this.getCredentials<Account>(credentialName);
		const botId = account.botId.trim();
		if (!botId) throw new NodeOperationError(this.getNode(), 'Bot ID is required.');
		if (active.has(botId))
			throw new NodeOperationError(
				this.getNode(),
				'This bot already has an active Weixin Trigger.',
			);
		active.add(botId);
		const controller = new AbortController();
		const signal = controller.signal;
		const directory = join(process.env.N8N_USER_FOLDER || homedir(), '.n8n', 'weixin');
		const file = join(directory, createHash('sha256').update(botId).digest('hex') + '.json');

		const run = async () => {
			await mkdir(directory, { recursive: true, mode: 0o700 });
			let inbox: Inbox;
			try {
				inbox = JSON.parse(await readFile(file, 'utf8')) as Inbox;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
				inbox = { cursor: '', pending: [], recent: [] };
			}
			const save = async () => {
				await writeFile(file + '.tmp', JSON.stringify(inbox), { mode: 0o600 });
				await rename(file + '.tmp', file);
			};
			let timeout = 35_000;
			while (!signal.aborted) {
				while (inbox.pending.length && !signal.aborted) {
					const message = inbox.pending.shift()!;
					const id = key(message);
					if (id) inbox.recent = [...inbox.recent, id].slice(-1024);
					// Mark the item dispatched before emit to avoid replaying an uncertain execution.
					await save();
					const text = (message.item_list ?? [])
						.map((item) => item.text_item?.text ?? item.voice_item?.text)
						.filter(Boolean)
						.join('\n');
					const attachments = (message.item_list ?? [])
						.map(attachment)
						.filter((value) => value !== undefined);
					const quote = message.item_list?.find((item) => item.ref_msg)?.ref_msg;
					this.emit([
						[
							{
								json: {
									messageId: message.message_id,
									botId,
									fromUserId: message.from_user_id,
									timestamp: message.create_time_ms,
									text,
									contextToken: message.context_token,
									attachments,
									...(quote
										? {
												replyTo: {
													title: quote.title,
													attachment: quote.message_item && attachment(quote.message_item),
												},
											}
										: {}),
								},
							},
						],
					]);
				}

				let response: {
					get_updates_buf?: string;
					msgs?: Message[];
					longpolling_timeout_ms?: number;
				};
				try {
					response = await botRequest(
						account,
						'getupdates',
						{ get_updates_buf: inbox.cursor },
						signal,
						timeout,
					);
				} catch (error) {
					if (signal.aborted || (error instanceof WeixinError && error.code === -14)) throw error;
					if (!(error instanceof Error && error.name === 'TimeoutError'))
						await delay(3_000, undefined, { signal });
					continue;
				}
				if (signal.aborted) return;
				if (response.longpolling_timeout_ms && response.longpolling_timeout_ms > 0)
					timeout = response.longpolling_timeout_ms;
				const known = new Set(inbox.recent);
				const cursor = response.get_updates_buf || inbox.cursor;
				for (const message of response.msgs ?? []) {
					if (message.group_id || message.message_type !== 1 || !message.from_user_id) continue;
					if (account.ownerUserId && account.ownerUserId !== message.from_user_id) continue;
					const id = key(message);
					if (id && known.has(id)) continue;
					if (id) known.add(id);
					inbox.pending.push(message);
				}
				if (cursor !== inbox.cursor || inbox.pending.length) {
					inbox.cursor = cursor;
					await save();
				}
			}
		};
		const task = run()
			.catch((error: unknown) => {
				if (!signal.aborted)
					this.emitError(
						new NodeOperationError(this.getNode(), error instanceof Error ? error : String(error)),
					);
			})
			.finally(() => active.delete(botId));
		return {
			closeFunction: async () => {
				controller.abort();
				await task;
			},
		};
	}
}
