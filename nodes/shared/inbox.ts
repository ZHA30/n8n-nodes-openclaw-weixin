import { createHash } from 'node:crypto';
import type { IDataObject, IBinaryData } from 'n8n-workflow';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { botRequest, WeixinError, type Account } from './api';
import { attachment, type MessageItem } from './media';
import { downloadMedia } from './media';

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
	contextTokens: Record<string, string>;
	generations: Record<string, number>;
	activeCommands: Record<string, string>;
}
type Output = IDataObject;
export type EventType = 'all' | 'text' | 'command' | 'image' | 'voice' | 'file' | 'video';
export type ChatMode = 'persistent' | 'perMessage';
export type ChatSession = { key: string; generation: number };
type ReplyWaiter = {
	onReset?: () => void;
	callback: (message: Output) => Promise<void>;
	claimed: boolean;
};
const replyWaiters = new Map<string, ReplyWaiter>();

function replyWaitKey(botId: string, userId: string, session?: ChatSession) {
	return JSON.stringify([botId.trim(), userId, session?.key, session?.generation]);
}

export async function getLatestContextToken(botId: string, userId: string): Promise<string | undefined> {
	try {
		const inbox = JSON.parse(await readFile(inboxPath(botId.trim()), 'utf8')) as Partial<Inbox>;
		return inbox.contextTokens?.[userId];
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
		throw error;
	}
}

export async function assertCurrentChatSession(botId: string, session: ChatSession): Promise<void> {
	const inbox = JSON.parse(await readFile(inboxPath(botId.trim()), 'utf8')) as Partial<Inbox>;
	if ((inbox.generations?.[session.key] ?? 0) !== session.generation)
		throw new Error('This Weixin chat session has already been reset.');
}

export function registerReplyWaiter(
	botId: string,
	userId: string,
	callback: (message: Output) => Promise<void>,
	session?: ChatSession,
	onReset?: () => void,
): () => void {
	const key = replyWaitKey(botId, userId, session);
	if (replyWaiters.has(key)) throw new Error('A Weixin reply is already pending for this conversation.');
	const waiter = { callback, claimed: false, onReset };
	replyWaiters.set(key, waiter);
	return () => {
		if (replyWaiters.get(key) === waiter) replyWaiters.delete(key);
	};
}

export async function dispatchReply(
	botId: string,
	userId: string,
	message: Output,
	onFailure?: (error: unknown) => void,
	session?: ChatSession,
): Promise<boolean> {
	const sessionKey = replyWaitKey(botId, userId, session);
	const key = replyWaiters.has(sessionKey) ? sessionKey : replyWaitKey(botId, userId);
	const waiter = replyWaiters.get(key);
	if (!waiter || waiter.claimed) return false;
	waiter.claimed = true;
	const delivery = Promise.resolve().then(async () => await waiter.callback(message)).finally(() => {
		if (replyWaiters.get(key) === waiter) replyWaiters.delete(key);
	});
	if (onFailure) void delivery.catch(onFailure);
	else await delivery;
	return true;
}

type Subscriber = {
	event: EventType;
	excludeCommands?: boolean;
	command?: string;
	manual: boolean;
	emit: (message: Output, binary?: Record<string, IBinaryData>) => void;
	prepareBinary?: (data: Buffer, fileName?: string, mimeType?: string) => Promise<IBinaryData>;
	error: (error: unknown) => void;
	messageError: (error: unknown) => void;
	chat?: { command?: string; mode: ChatMode; key: string };
	reply?: (text: string, contextToken: string) => Promise<void>;
};
type Receiver = {
	account: Account;
	subscribers: Set<Subscriber>;
	controller: AbortController;
	task: Promise<void>;
};
const receivers = new Map<string, Receiver>();

export function messageKey(message: Message) {
	const id = message.message_id ?? message.item_list?.find((item) => item.msg_id)?.msg_id;
	return id
		? JSON.stringify([message.from_user_id, id])
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
	const ownerUserId = account.ownerUserId.trim();
	const signal = controller.signal;
	const directory = join(process.env.N8N_USER_FOLDER || homedir(), '.n8n', 'weixin');
	const file = inboxPath(botId);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	let inbox: Inbox;
	try {
		inbox = JSON.parse(await readFile(file, 'utf8')) as Inbox;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		inbox = { cursor: '', pending: [], recent: [], contextTokens: {}, generations: {}, activeCommands: {} };
	}
	inbox.contextTokens ??= {};
	inbox.generations ??= {};
	inbox.activeCommands ??= {};
	const save = async () => {
		await writeFile(file + '.tmp', JSON.stringify(inbox), { mode: 0o600 });
		await rename(file + '.tmp', file);
	};
	let timeout = 35_000;
	while (!signal.aborted) {
		while (inbox.pending.length && !signal.aborted) {
			const message = inbox.pending[0];
			const id = messageKey(message);
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
			if (message.context_token && message.from_user_id) {
				inbox.contextTokens[message.from_user_id] = message.context_token;
				await save();
			}
			const itemTypes = new Set((message.item_list ?? []).map((item) => item.type));
			const listeners = [...subscribers];
			const production = listeners.filter((subscriber) => !subscriber.manual);
			const routing = production.length ? production : listeners;
			const chatSubscribers = routing.filter((subscriber) => subscriber.chat);
			const userId = message.from_user_id!;
			const primaryChat = chatSubscribers.find((subscriber) => !subscriber.chat!.command);
			const selectedChat = primaryChat ?? chatSubscribers.find(
				(subscriber) => subscriber.chat!.command === inbox.activeCommands[userId],
			);
			const getSession = (subscriber: Subscriber): ChatSession => {
				const key = `${userId}:${subscriber.chat!.key}`;
				return { key, generation: inbox.generations[key] ?? 0 };
			};
			const session = selectedChat ? getSession(selectedChat) : undefined;
			const reset = parsed?.command === 'new' && commandText?.trim().toLowerCase() === '/new' &&
				message.item_list?.length === 1;
			const chatCommand = parsed && !primaryChat && chatSubscribers.find(
				(subscriber) => subscriber.command === parsed.command,
			);
			const ordinaryCommand = parsed && routing.some((subscriber) => !subscriber.chat && subscriber.command === parsed.command);
			const controlMessage = reset || chatCommand || ordinaryCommand || (parsed && parsed.command !== 'new' && !primaryChat);
			const resumed = !controlMessage && await dispatchReply(botId, userId, output, (error) => {
				for (const subscriber of routing) subscriber.messageError(error);
			}, session);
			const downloadedAttachments = new Map<number, { data: Buffer; fileName?: string }>();
			const commandList = chatSubscribers.map((subscriber) => `/${subscriber.command}`).sort().join('\n');
			const replyingSubscriber = chatSubscribers.find((subscriber) => subscriber.reply);
			const replyContextToken = message.context_token || inbox.contextTokens[userId];
			const reply = async (subscriber: Subscriber | undefined, text: string) => {
				if (!production.length || !subscriber?.reply || !replyContextToken) return;
				try {
					await subscriber.reply(text, replyContextToken);
				} catch (error) {
					subscriber.messageError(error);
				}
			};
			if (reset && session && production.length) {
				inbox.generations[session.key] = session.generation + 1;
				inbox.pending.shift();
				if (id) inbox.recent = [...inbox.recent, id].slice(-1024);
				await save();
				for (const waiterKey of [replyWaitKey(botId, userId, session), replyWaitKey(botId, userId)]) {
					const waiter = replyWaiters.get(waiterKey);
					replyWaiters.delete(waiterKey);
					waiter?.onReset?.();
				}
				await reply(selectedChat, 'Started a new session.');
				continue;
			} else if (chatCommand && production.length) {
				inbox.activeCommands[userId] = chatCommand.command!;
				await save();
				await reply(chatCommand, `/${chatCommand.command}`);
			} else if (!resumed && !ordinaryCommand && !primaryChat && (!selectedChat || controlMessage)) {
				await reply(replyingSubscriber, commandList);
			}
			const typeNumbers: Partial<Record<EventType, number>> = {
				text: 1,
				image: 2,
				voice: 3,
				file: 4,
				video: 5,
			};
			for (const subscriber of listeners) {
				if (resumed || !subscribers.has(subscriber)) continue;
				if (subscriber.chat) {
					if (controlMessage || (production.length &&
						(!selectedChat || (subscriber !== selectedChat &&
							(!subscriber.manual || subscriber.chat.command !== selectedChat.chat!.command))))) continue;
					const chatSession = getSession(subscriber);
					const sessionId = `${botId}:${chatSession.key}`;
					const binary: Record<string, IBinaryData> = {};
					for (let index = 0; index < attachments.length; index++) {
						const media = attachments[index];
						if (!media || !subscriber.prepareBinary) continue;
						try {
							let downloaded = downloadedAttachments.get(index);
							if (!downloaded) {
								downloaded = await downloadMedia(media, signal);
								downloadedAttachments.set(index, downloaded);
							}
							binary[`attachment_${index + 1}`] = await subscriber.prepareBinary(
								downloaded.data,
								downloaded.fileName,
								media.type === 'voice' ? 'audio/silk' : undefined,
							);
						} catch (error) {
							if (signal.aborted) return;
							subscriber.messageError(error);
						}
					}
					if (!subscribers.has(subscriber) || signal.aborted) continue;
					subscriber.emit({
						...output,
						chatInput: text,
						weixinSession: chatSession,
						sessionId:
							subscriber.chat.mode === 'perMessage'
								? `${sessionId}:${message.message_id ?? message.item_list?.find((item) => item.msg_id)?.msg_id ?? Date.now()}`
								: `${sessionId}:${chatSession.generation}`,
					}, binary);
				} else if (subscriber.event === 'command') {
					if (subscriber.command === parsed?.command) subscriber.emit({ ...output, ...parsed });
				} else if (
					subscriber.event === 'all' ||
					(itemTypes.has(typeNumbers[subscriber.event]) &&
						!(subscriber.event === 'text' && subscriber.excludeCommands && parsed))
				) {
					subscriber.emit(output);
				}
			}
			inbox.pending.shift();
			if (id) inbox.recent = [...inbox.recent, id].slice(-1024);
			await save();
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
		const known = new Set([...inbox.recent, ...inbox.pending.map(messageKey).filter((id): id is string => !!id)]);
		const cursor = response.get_updates_buf || inbox.cursor;
		for (const message of response.msgs ?? []) {
			if (message.group_id || message.message_type !== 1 || !message.from_user_id) continue;
			if (ownerUserId !== message.from_user_id) continue;
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
	if (!account.ownerUserId?.trim()) throw new Error('userId is required in the Weixin credential.');
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
		if (subscriber.chat && !subscriber.manual &&
			[...receiver.subscribers].some((item) =>
				!item.manual && item.chat && (!item.chat.command || !subscriber.chat!.command),
			)) {
			throw new Error('Primary Chat must be the only active Weixin Chat Trigger for this Bot ID.');
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
