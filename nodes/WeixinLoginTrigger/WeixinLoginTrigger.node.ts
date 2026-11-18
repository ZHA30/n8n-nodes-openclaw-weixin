import { randomUUID } from 'node:crypto';
import type {
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';
import { toDataURL } from 'qrcode';
import { baseUrl, request } from '../shared/api';
import { loginContent, loginCss } from './login-content';

interface Status {
	status: string;
	redirect_host?: string;
	bot_token?: string;
	ilink_bot_id?: string;
	ilink_user_id?: string;
	baseurl?: string;
}
interface Session {
	code: string;
	image: string;
	host: string;
	status: Status;
	pin?: string;
	controller: AbortController;
}
const sessions = new Map<string, Session>();

async function poll(session: Session) {
	while (!session.controller.signal.aborted) {
		const query = new URLSearchParams({ qrcode: session.code });
		if (session.pin) {
			query.set('verify_code', session.pin);
			delete session.pin;
		}
		try {
			session.status = await request<Status>(session.host, 'get_qrcode_status', {
				query,
				signal: session.controller.signal,
				timeout: 35_000,
			});
		} catch (error) {
			if (session.controller.signal.aborted) return;
			if (error instanceof Error && error.name === 'TimeoutError') continue;
			session.status = { status: 'failed' };
			return;
		}
		const { status, redirect_host: host } = session.status;
		if (status === 'scaned_but_redirect') {
			if (!host || !/^[a-z0-9.-]+\.weixin\.qq\.com$/i.test(host)) {
				session.status = { status: 'failed' };
				return;
			}
			session.host = 'https://' + host;
		}
		if (['confirmed', 'expired', 'verify_code_blocked', 'binded_redirect'].includes(status)) return;
		if (status.includes('need_verifycode')) {
			while (!session.pin && !session.controller.signal.aborted) {
				await new Promise((resolve) => setTimeout(resolve, 200));
			}
		}
	}
}

export class WeixinLoginTrigger implements INodeType {
	description: INodeTypeDescription = {
		icon: 'file:../../assets/icon.svg',
		subtitle: 'QR binding',
		displayName: 'OpenClaw Weixin Login Trigger',
		name: 'weixinLoginTrigger',
		group: ['trigger'],
		version: 1,
		description: 'Bind a Weixin account using a QR code',
		defaults: { name: 'OpenClaw Weixin Login Trigger' },
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		webhooks: [
			{
				name: 'setup',
				httpMethod: 'GET',
				responseMode: 'onReceived',
				path: 'login',
				ndvHideUrl: true,
			},
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'login',
			},
		],
		properties: [],
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const res = this.getResponseObject();
		const req = this.getRequestObject();
		res.setHeader('Cache-Control', 'no-store');
		const handled = { noWebhookResponse: true };
		if (this.getMode() !== 'manual') {
			res.status(404).send('Open the Test URL from the editor.');
			return handled;
		}

		const scope = this.getWorkflow().id + ':' + this.getNode().id + ':';
		const id = req.method === 'GET' ? randomUUID() : String(req.body?.session ?? '');
		const key = scope + id;
		const previous = sessions.get(key);
		const refresh = req.body?.action === 'refresh';
		if (req.method !== 'GET') {
			// Sandboxed n8n forms use an opaque origin. The session ID authorizes status requests.
			if (req.headers.origin === 'null') res.setHeader('Access-Control-Allow-Origin', 'null');
			if (!previous) {
				res.status(410).json({ status: 'ended' });
				return handled;
			}
			if (
				!refresh ||
				!['expired', 'verify_code_blocked', 'failed'].includes(previous.status.status)
			) {
				const result = previous.status;
				if (result.status === 'confirmed') {
					sessions.delete(key);
					previous.controller.abort();
					if (!result.bot_token || !result.ilink_bot_id) {
						res.json({ status: 'ended' });
						return handled;
					}
					res.json({ status: 'confirmed' });
					return {
						...handled,
						workflowData: [
							[
								{
									json: {
										botToken: result.bot_token,
										baseUrl: result.baseurl || baseUrl,
										botId: result.ilink_bot_id,
										userId: result.ilink_user_id,
									},
								},
							],
						],
					};
				}
				const pin = String(req.body?.pin ?? '');
				if (result.status.includes('need_verifycode') && /^\d{4,8}$/.test(pin)) {
					previous.pin = pin;
					previous.status = { status: 'scaned' };
				}
				res.json({ status: previous.status.status });
				return handled;
			}
		}

		try {
			const qr = await request<{ qrcode: string; qrcode_img_content: string }>(
				baseUrl,
				'get_bot_qrcode',
				{
					body: { local_token_list: [] },
					query: new URLSearchParams({ bot_type: '3' }),
				},
			);
			const image = await toDataURL(qr.qrcode_img_content, { width: 280 });
			const session: Session = {
				code: qr.qrcode,
				image,
				host: baseUrl,
				status: { status: 'wait' },
				controller: new AbortController(),
			};
			if (refresh && sessions.get(key) !== previous) {
				res.status(410).json({ status: 'ended' });
				return handled;
			}
			for (const [existingKey, existing] of sessions) {
				if (existingKey.startsWith(scope)) {
					existing.controller.abort();
					sessions.delete(existingKey);
				}
			}
			sessions.set(key, session);
			setTimeout(() => {
				session.controller.abort();
				if (sessions.get(key) === session) sessions.delete(key);
			}, 120_000).unref();
			void poll(session);

			if (refresh) {
				res.json({ status: 'wait', image });
			} else {
				res.render('form-trigger', {
					formTitle: 'Weixin login',
					formFields: [{ isHtml: true, id: 'weixin-content', html: loginContent(id, image) }],
					dangerousCustomCss: loginCss,
				});
			}
		} catch {
			if (refresh) res.status(502).json({ status: 'failed' });
			else res.status(502).send('Could not get a QR code. Reload the page to retry.');
		}
		return handled;
	}
}
