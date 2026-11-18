import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { IDataObject } from 'n8n-workflow';
import { botRequest, type Account } from './api';

interface Media {
	full_url?: string;
	encrypt_query_param?: string;
	aes_key?: string;
}
interface MediaItem {
	media?: Media;
}
export interface MessageItem {
	type?: number;
	text_item?: { text?: string };
	image_item?: MediaItem & { aeskey?: string };
	video_item?: MediaItem;
	voice_item?: MediaItem & { text?: string };
	file_item?: MediaItem & { file_name?: string; len?: string };
	ref_msg?: { title?: string; message_item?: MessageItem };
}
export interface Attachment extends IDataObject {
	type: string;
	fileName?: string;
	size?: string;
	query?: string;
	url?: string;
	key?: string;
}

export function attachment(item: MessageItem): Attachment | undefined {
	const media = {
		2: item.image_item?.media,
		3: item.voice_item?.media,
		4: item.file_item?.media,
		5: item.video_item?.media,
	}[item.type ?? 0];
	if (!media || (!media.full_url && !media.encrypt_query_param)) return;
	return {
		type: ['', '', 'image', 'voice', 'file', 'video'][item.type ?? 0],
		fileName: item.file_item?.file_name,
		size: item.file_item?.len,
		query: media.encrypt_query_param,
		url: media.full_url,
		key: item.image_item?.aeskey
			? Buffer.from(item.image_item.aeskey, 'hex').toString('base64')
			: media.aes_key,
	};
}

const cdn = 'https://novac2c.cdn.weixin.qq.com/c2c';
const maxBytes = 100 * 1024 * 1024;

function cdnUrl(full: string | undefined, operation: string, query?: string, key?: string) {
	if (!full && !query) throw new Error('Weixin CDN reference is missing.');
	const url = new URL(full || cdn + '/' + operation);
	if (
		url.protocol !== 'https:' ||
		url.port ||
		url.username ||
		url.password ||
		!(url.hostname.endsWith('.weixin.qq.com') || url.hostname.endsWith('.wechat.com'))
	) {
		throw new Error('Unrecognized Weixin CDN address.');
	}
	if (!full && query) url.searchParams.set('encrypted_query_param', query);
	if (!full && key) url.searchParams.set('filekey', key);
	return url;
}

function deadline(signal?: AbortSignal) {
	const timeout = AbortSignal.timeout(120_000);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function uploadMedia(
	account: Account,
	type: 'image' | 'video' | 'file',
	to: string,
	file: Buffer,
	fileName: string,
	signal?: AbortSignal,
) {
	if (file.length > maxBytes) throw new Error('Attachment exceeds 100 MiB.');
	const key = randomBytes(16);
	const filekey = randomBytes(16).toString('hex');
	const cipher = createCipheriv('aes-128-ecb', key, null);
	const encrypted = Buffer.concat([cipher.update(file), cipher.final()]);
	const result = await botRequest<{ upload_full_url?: string; upload_param?: string }>(
		account,
		'getuploadurl',
		{
			filekey,
			media_type: { image: 1, video: 2, file: 3 }[type],
			to_user_id: to,
			rawsize: file.length,
			rawfilemd5: createHash('md5').update(file).digest('hex'),
			filesize: encrypted.length,
			no_need_thumb: true,
			aeskey: key.toString('hex'),
		},
		signal,
	);
	const url = cdnUrl(result.upload_full_url, 'upload', result.upload_param, filekey);
	const response = await fetch(url, {
		method: 'POST',
		body: new Uint8Array(encrypted),
		headers: { 'Content-Type': 'application/octet-stream' },
		redirect: 'error',
		signal: deadline(signal),
	});
	await response.body?.cancel();
	const query = response.headers.get('x-encrypted-param');
	if (!response.ok || !query) throw new Error(`Weixin CDN upload failed (${response.status}).`);
	const media = {
		encrypt_query_param: query,
		aes_key: Buffer.from(key.toString('hex')).toString('base64'),
		encrypt_type: 1,
	};
	if (type === 'image') return { type: 2, image_item: { media, mid_size: encrypted.length } };
	if (type === 'video') return { type: 5, video_item: { media, video_size: encrypted.length } };
	return { type: 4, file_item: { media, file_name: fileName, len: String(file.length) } };
}

export async function downloadMedia(item: Attachment, signal?: AbortSignal) {
	if (!['image', 'video', 'voice', 'file'].includes(item?.type))
		throw new Error('A Weixin attachment is required.');
	let key = item.key ? Buffer.from(item.key, 'base64') : undefined;
	if (key?.length === 32 && /^[0-9a-f]{32}$/i.test(key.toString('ascii')))
		key = Buffer.from(key.toString('ascii'), 'hex');
	if (key ? key.length !== 16 : item.type !== 'image')
		throw new Error('Invalid or missing Weixin media key.');

	const response = await fetch(cdnUrl(item.url, 'download', item.query), {
		redirect: 'error',
		signal: deadline(signal),
	});
	if (!response.ok || !response.body) {
		await response.body?.cancel();
		throw new Error(`Weixin CDN download failed (${response.status}).`);
	}
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of response.body) {
		bytes += chunk.byteLength;
		if (bytes > maxBytes + 16) throw new Error('Attachment exceeds 100 MiB.');
		chunks.push(Buffer.from(chunk));
	}
	const buffer = Buffer.concat(chunks);
	const decipher = key ? createDecipheriv('aes-128-ecb', key, null) : undefined;
	return {
		data: decipher ? Buffer.concat([decipher.update(buffer), decipher.final()]) : buffer,
		fileName:
			item.fileName || { video: 'video.mp4', voice: 'voice.silk' }[item.type as 'video' | 'voice'],
	};
}
