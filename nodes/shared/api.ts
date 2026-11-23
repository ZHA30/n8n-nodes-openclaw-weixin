import { randomBytes, randomUUID } from 'node:crypto';
import { parse, isLosslessNumber } from 'lossless-json';

export const baseUrl = 'https://ilinkai.weixin.qq.com';
export const credentialName = 'weixinApi';

export interface Account {
	baseUrl?: string;
	botToken: string;
	botId: string;
	ownerUserId: string;
}

export class WeixinError extends Error {
	constructor(
		readonly code: number,
		operation: string,
	) {
		super(
			code === -14
				? 'Weixin session expired. Bind the account again.'
				: `Weixin ${operation} failed (${code}).`,
		);
	}
}

export async function request<T>(
	host: string,
	operation: string,
	options: {
		body?: object;
		token?: string;
		query?: URLSearchParams;
		signal?: AbortSignal;
		timeout?: number;
	} = {},
): Promise<T> {
	const url = new URL('/ilink/bot/' + operation, host);
	if (options.query) url.search = options.query.toString();
	const headers: Record<string, string> = {
		'iLink-App-Id': 'bot',
		'iLink-App-ClientVersion': '196608',
	};
	if (options.body) {
		headers['Content-Type'] = 'application/json';
		headers.AuthorizationType = 'ilink_bot_token';
		headers['X-WECHAT-UIN'] = Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64');
	}
	if (options.token) headers.Authorization = `Bearer ${options.token}`;
	const timeout = AbortSignal.timeout(options.timeout ?? 15_000);
	let response: Response;
	let raw: string;
	try {
		response = await fetch(url, {
			headers,
			method: options.body ? 'POST' : 'GET',
			body: options.body ? JSON.stringify(options.body) : undefined,
			signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
			redirect: 'error',
		});
		raw = await response.text();
	} catch {
		options.signal?.throwIfAborted();
		if (timeout.aborted) throw timeout.reason;
		throw new Error(`Weixin ${operation} request failed.`);
	}
	if (!response.ok) throw new WeixinError(response.status, operation);
	const result = parse(raw, (key, value) => {
		if (!isLosslessNumber(value)) return value;
		return key === 'message_id' || key === 'msg_id' ? value.toString() : Number(value.toString());
	}) as T & { ret?: number; errcode?: number };
	const code = result.errcode || result.ret;
	if (code) throw new WeixinError(code, operation);
	return result;
}

export function botRequest<T>(
	account: Account,
	operation: string,
	body: object,
	signal?: AbortSignal,
	timeout?: number,
) {
	return request<T>(account.baseUrl?.trim() || baseUrl, operation, {
		token: account.botToken,
		body: { ...body, base_info: { channel_version: '3.0.0-beta-0', bot_agent: 'n8n' } },
		signal,
		timeout,
	});
}

export type OutboundMessageItem = {
	type: number;
	text_item?: object;
	image_item?: object;
	video_item?: object;
	file_item?: object;
};

export async function sendMessageItem(
	account: Account,
	toUserId: string,
	item: OutboundMessageItem,
	contextToken?: string,
	signal?: AbortSignal,
	clientId = randomUUID(),
) {
	return await botRequest<{ message_id?: string }>(account, 'sendmessage', {
		msg: {
			from_user_id: '', to_user_id: toUserId, context_token: contextToken || undefined,
			client_id: clientId, message_type: 2, message_state: 2, item_list: [item],
		},
	}, signal);
}

export async function sendTextMessage(
	account: Account,
	toUserId: string,
	text: string,
	contextToken?: string,
	signal?: AbortSignal,
	clientId = randomUUID(),
) {
	return await botRequest<{ message_id?: string }>(account, 'sendmessage', {
		msg: {
			from_user_id: '', to_user_id: toUserId, context_token: contextToken || undefined,
			client_id: clientId, message_type: 2, message_state: 2,
			item_list: [{ type: 1, text_item: { text } }],
		},
	}, signal);
}
