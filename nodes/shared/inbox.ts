import { createHash } from 'node:crypto';
import type { IDataObject } from 'n8n-workflow';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { botRequest, WeixinError, type Account } from './api';
import { attachment, type MessageItem } from './media';

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
type Output = IDataObject;
export type EventType = 'all' | 'text' | 'command' | 'image' | 'voice' | 'file' | 'video';
type Subscriber = {
	event: EventType;
	excludeCommands?: boolean;
	command?: string;
	manual: boolean;
	emit: (message: Output) => void;
	error: (error: unknown) => void;
};
type Receiver = {
	account: Account;
	subscribers: Set<Subscriber>;
	controller: AbortController;
	task: Promise<void>;
};
const receivers = new Map<string, Receiver>();

function messageKey(message: Message) {
	return message.message_id
		? JSON.stringify([message.from_user_id, message.message_id])
		: undefined;
}

export function parseCommand(text: string) {
	const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
	return match ? { command: match[1].toLowerCase(), args: (match[2] ?? '').trim() } : undefined;
}

function inboxPath(botId: string) {
	return join(
		process.env.N8N_USER_FOLDER || homedir(),
		'.n8n',
		'weixin',
		createHash('sha256').update(botId).digest('hex') + '.json',
	);
}

async function run(receiver: Receiver, botId: string) {
	const { account, controller, subscribers } = receiver;
	const signal = controller.signal;
	const directory = join(process.env.N8N_USER_FOLDER || homedir(), '.n8n', 'weixin');
	const file = inboxPath(botId);
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
			const id = messageKey(message);
			if (id) inbox.recent = [...inbox.recent, id].slice(-1024);
			await save();
			const text = (message.item_list ?? [])
				.map((item) => item.text_item?.text ?? item.voice_item?.text)
				.filter(Boolean)
				.join('\n');
			const commandText = (message.item_list ?? []).find(
				(item) => item.type === 1 && item.text_item?.text != null,
			)?.text_item?.text;
			const parsed = commandText == null ? undefined : parseCommand(commandText);
			const attachments = (message.item_list ?? [])
				.map(attachment)
				.filter((value) => value !== undefined);
			const quote = message.item_list?.find((item) => item.ref_msg)?.ref_msg;
			const output: Output = {
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
			};
			const itemTypes = new Set((message.item_list ?? []).map((item) => item.type));
			const typeNumbers: Partial<Record<EventType, number>> = {
				text: 1,
				image: 2,
				voice: 3,
				file: 4,
				video: 5,
			};
			for (const subscriber of subscribers) {
				if (subscriber.event === 'command') {
					if (subscriber.command === parsed?.command) subscriber.emit({ ...output, ...parsed });
				} else if (
					subscriber.event === 'all' ||
					(itemTypes.has(typeNumbers[subscriber.event]) &&
						!(subscriber.event === 'text' && subscriber.excludeCommands && parsed))
				) {
					subscriber.emit(output);
				}
			}
		}
		let response: { get_updates_buf?: string; msgs?: Message[]; longpolling_timeout_ms?: number };
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
			const id = messageKey(message);
			if (id && known.has(id)) continue;
			if (id) known.add(id);
			inbox.pending.push(message);
		}
		if (cursor !== inbox.cursor || inbox.pending.length) {
			inbox.cursor = cursor;
			await save();
		}
	}
}

export async function subscribe(
	account: Account,
	subscriber: Subscriber,
): Promise<() => Promise<void>> {
	const botId = account.botId.trim();
	if (!botId) throw new Error('Bot ID is required.');
	let receiver = receivers.get(botId);
	if (receiver?.controller.signal.aborted) {
		await receiver.task;
		receiver = receivers.get(botId);
	}
	if (receiver) {
		if (
			receiver.account.botToken !== account.botToken ||
			(receiver.account.baseUrl?.trim() || '') !== (account.baseUrl?.trim() || '') ||
			(receiver.account.ownerUserId || '') !== (account.ownerUserId || '')
		) {
			throw new Error('The active Weixin Trigger for this Bot ID uses different credentials.');
		}
		if (
			subscriber.command &&
			!subscriber.manual &&
			[...receiver.subscribers].some((item) => !item.manual && item.command === subscriber.command)
		) {
			throw new Error(`The command /${subscriber.command} is already registered for this bot.`);
		}
	} else {
		receiver = {
			account,
			subscribers: new Set(),
			controller: new AbortController(),
			task: Promise.resolve(),
		};
		receivers.set(botId, receiver);
		const current = receiver;
		current.task = new Promise<void>((resolve) => setImmediate(resolve))
			.then(() => run(current, botId))
			.catch((error: unknown) => {
				if (!current.controller.signal.aborted) {
					for (const item of current.subscribers) item.error(error);
				}
			})
			.finally(() => {
				if (receivers.get(botId) === current) receivers.delete(botId);
			});
	}
	const current = receiver;
	current.subscribers.add(subscriber);
	return async () => {
		current.subscribers.delete(subscriber);
		if (!current.subscribers.size) {
			current.controller.abort();
			await current.task;
		}
	};
}
