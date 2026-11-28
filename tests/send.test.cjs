const assert = require('node:assert/strict');
const test = require('node:test');
const { Weixin } = require('../dist/nodes/Weixin/Weixin.node.js');
const { WeixinChat } = require('../dist/nodes/WeixinChat/WeixinChat.node.js');
const { dispatchReply } = require('../dist/nodes/shared/inbox.js');

test('sends only to the credential-bound user and preserves context', async () => {
	const oldFetch = global.fetch;
	const account = { botId: 'bot', botToken: 'token', ownerUserId: 'owner' };
	const requests = [];
	global.fetch = async (_url, options) => {
		requests.push(JSON.parse(options.body));
		return { ok: true, text: async () => '{"ret":0,"message_id":"1"}' };
	};
	const context = (parameters, credential = account) => ({
		getNodeParameter: (name, _index, fallback) => parameters[name] ?? fallback,
		getCredentials: async () => credential,
		getExecutionCancelSignal: () => undefined,
		getInputData: () => [{ json: {} }],
		getNode: () => ({ name: 'test', type: 'test', typeVersion: 1, position: [0, 0] }),
		continueOnFail: () => false,
	});
	try {
		await new Weixin().execute.call(context({ operation: 'text', text: 'hello' }));
		assert.equal(requests[0].msg.to_user_id, 'owner');
		assert.equal('context_token' in requests[0].msg, false);
		await new Weixin().execute.call(context({ operation: 'text', text: 'hello' }));
		assert.equal(requests[1].msg.to_user_id, 'owner');
		await assert.rejects(
			() => new Weixin().execute.call(context({ operation: 'text', text: 'hello' }, { botId: 'bot', botToken: 'token' })),
			/userId is required/,
		);
	} finally {
		global.fetch = oldFetch;
	}
});

test('Weixin send properties do not expose recipient or context token fields', () => {
	const { NodeHelpers } = require('n8n-workflow');
	const description = new Weixin().description;
	assert.equal(description.properties.some((property) => property.name === 'contextToken'), false);
	assert.equal(description.properties.some((property) => property.name === 'toUserId'), false);
});

test('Weixin Chat replies to the triggering user with its context token', async () => {
	const oldFetch = global.fetch;
	let sent;
	global.fetch = async (_url, options) => {
		sent = JSON.parse(options.body);
		return { ok: true, text: async () => '{"ret":0,"message_id":"reply-1"}' };
	};
	const context = {
		getInputData: () => [{ json: { chatInput: 'question', fromUserId: 'user-1', contextToken: 'token-1', sessionId: 's' } }],
		getNodeParameter: (name, _index, fallback) => ({ text: 'answer' })[name] ?? fallback,
		getCredentials: async () => ({ botId: 'bot', botToken: 'secret', ownerUserId: 'user-1' }),
		getExecutionCancelSignal: () => undefined,
		getNode: () => ({ name: 'test', type: 'test', typeVersion: 1, position: [0, 0] }),
	};
	try {
		const output = await new WeixinChat().execute.call(context);
		assert.equal(sent.msg.to_user_id, 'user-1');
		assert.equal(sent.msg.context_token, 'token-1');
		assert.equal(output[0][0].json.sent, true);
		assert.equal(output[0][0].json.sessionId, 's');
	} finally {
		global.fetch = oldFetch;
	}
});


test('Weixin Chat loads the latest context token from the persisted inbox when its input omits it', async () => {
	const fs = require('node:fs');
	const os = require('node:os');
	const path = require('node:path');
	const { createHash } = require('node:crypto');
	const oldFolder = process.env.N8N_USER_FOLDER;
	const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'weixin-chat-token-'));
	process.env.N8N_USER_FOLDER = folder;
	const botId = 'persisted-token-bot';
	const directory = path.join(folder, '.n8n', 'weixin');
	fs.mkdirSync(directory, { recursive: true });
	const file = path.join(directory, `${createHash('sha256').update(botId).digest('hex')}.json`);
	fs.writeFileSync(file, JSON.stringify({ contextTokens: { 'persisted-user': 'persisted-context' } }));
	const oldFetch = global.fetch;
	let sent;
	global.fetch = async (_url, options) => {
		sent = JSON.parse(options.body);
		return { ok: true, text: async () => '{"ret":0,"message_id":"reply"}' };
	};
	const context = {
		getInputData: () => [{ json: { output: 'answer' } }],
		getNodeParameter: (name, _index, fallback) => ({ text: 'answer' })[name] ?? fallback,
		getCredentials: async () => ({ botId, botToken: 'secret', ownerUserId: 'persisted-user' }),
		getExecutionCancelSignal: () => undefined,
		getNode: () => ({ name: 'test', type: 'test', typeVersion: 1, position: [0, 0] }),
	};
	try {
		await new WeixinChat().execute.call(context);
		assert.equal(sent.msg.context_token, 'persisted-context');
	} finally {
		global.fetch = oldFetch;
		if (oldFolder === undefined) delete process.env.N8N_USER_FOLDER;
		else process.env.N8N_USER_FOLDER = oldFolder;
		fs.rmSync(folder, { recursive: true, force: true });
	}
});

test('Send and Wait registers before sending and resumes with inbox message data', async () => {
	const oldFetch = global.fetch;
	const events = [];
	let resumePayload;
	let resumeAttempts = 0;
	let delivery;
	global.fetch = async (url, options) => {
		if (url === 'https://n8n.test/resume') {
			assert.deepEqual(events, ['wait']);
			if (++resumeAttempts === 1) throw new Error('Temporary network failure');
			if (resumeAttempts === 2) return { ok: false, status: 409 };
			resumePayload = JSON.parse(options.body);
			return { ok: true, status: 200 };
		}
		// Simulate an immediate reply arriving during the send request.
		delivery = dispatchReply('wait-bot', 'user-wait', { messageId: 'reply', text: 'done' });
		return { ok: true, text: async () => '{"ret":0,"message_id":"sent"}' };
	};
	let finish;
	let waitUntil;
	const context = {
		getInputData: () => [{ json: { fromUserId: 'user-wait', contextToken: 'ctx' } }],
		getNodeParameter: (name, _index, fallback) => ({ text: 'question', operation: 'sendAndWait', waitTimeout: 1 })[name] ?? fallback,
		getCredentials: async () => ({ botId: 'wait-bot', botToken: 'secret', ownerUserId: 'user-wait' }),
		getExecutionCancelSignal: () => undefined,
		getWorkflowDataProxy: () => ({ $execution: { resumeUrl: 'https://n8n.test/resume' } }),
		putExecutionToWait: async (date) => { waitUntil = date; events.push('wait'); },
		onExecutionFinish: (callback) => { finish = callback; },
		getNode: () => ({ name: 'test', type: 'test', typeVersion: 1, position: [0, 0] }),
	};
	try {
		await new WeixinChat().execute.call(context);
		assert.ok(waitUntil instanceof Date);
		assert.equal(await delivery, true);
		assert.equal(resumeAttempts, 3);
		assert.deepEqual(resumePayload.data, { messageId: 'reply', text: 'done' });
		assert.equal(await dispatchReply('wait-bot', 'user-wait', { text: 'again' }), false);
		finish();
	} finally {
		global.fetch = oldFetch;
		finish?.();
	}
});

test('waiting webhook unwraps n8n resume data', async () => {
	const result = await new WeixinChat().webhook.call({ getBodyData: () => ({ data: { text: 'reply' } }) });
	assert.deepEqual(result.workflowData, [[{ json: { text: 'reply' } }]]);
});

test('Send and Wait rejects multiple items rather than registering ambiguous waits', async () => {
	const context = {
		getInputData: () => [{ json: {} }, { json: {} }],
		getNodeParameter: (_name, _index, fallback) => fallback === 'send' ? 'sendAndWait' : fallback,
		getNode: () => ({ name: 'test', type: 'test', typeVersion: 1, position: [0, 0] }),
	};
	await assert.rejects(() => new WeixinChat().execute.call(context), /one input item per execution/);
});

test('Weixin Chat rejects an unsupported attachment before sending text', async (t) => {
	const fetch = t.mock.method(globalThis, 'fetch', async () => ({
		ok: true,
		text: async () => '{"ret":0}',
	}));
	const context = {
		getInputData: () => [{
			json: { fromUserId: 'owner', contextToken: 'context' },
			binary: { attachment: { mimeType: 'audio/mpeg' } },
		}],
		getNodeParameter: (name, _index, fallback) => name === 'text' ? 'answer' : fallback,
		getCredentials: async () => ({ botId: 'bot', botToken: 'token', ownerUserId: 'owner' }),
		getExecutionCancelSignal: () => undefined,
		getNode: () => ({ name: 'Weixin Chat', type: 'weixinChat', typeVersion: 1, position: [0, 0] }),
	};
	await assert.rejects(() => new WeixinChat().execute.call(context), /only image or PDF/);
	assert.equal(fetch.mock.callCount(), 0);
});

test('an expired Chat wait leaves the next reply available to a newer execution', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
	const resumeUrls = [];
	t.mock.method(globalThis, 'fetch', async (url) => {
		if (typeof url === 'string') resumeUrls.push(url);
		return { ok: true, text: async () => '{"ret":0}' };
	});
	const botId = 'expiring-wait-bot';
	const userId = 'owner';
	const chat = new WeixinChat();
	function context(resumeUrl) {
		return {
			getInputData: () => [{ json: { fromUserId: userId, contextToken: 'ctx' } }],
			getNodeParameter: (name, _index, fallback) =>
				({ text: 'question', operation: 'sendAndWait', waitTimeout: 1 })[name] ?? fallback,
			getCredentials: async () => ({ botId, botToken: 'token', ownerUserId: userId }),
			getExecutionCancelSignal: () => undefined,
			getWorkflowDataProxy: () => ({ $execution: { resumeUrl } }),
			getNode: () => ({ name: 'Weixin Chat' }),
			putExecutionToWait: async () => {},
		};
	}
	await chat.execute.call(context('https://n8n.test/expired'));
	t.mock.timers.tick(60_000);
	await chat.execute.call(context('https://n8n.test/current'));
	assert.equal(await dispatchReply(botId, userId, { text: 'reply' }), true);
	assert.deepEqual(resumeUrls, ['https://n8n.test/current']);
});

test('Chat uses the linked Weixin event after Agent output and rejects a different bot', async (t) => {
	const requests = [];
	t.mock.method(globalThis, 'fetch', async (_url, options) => {
		requests.push(JSON.parse(options.body));
		return { ok: true, text: async () => '{"ret":0}' };
	});
	const event = { botId: 'my-bot', fromUserId: 'owner', contextToken: 'original-context' };
	const context = {
		getInputData: () => [{ json: { output: 'answer from Agent' } }],
		getNodeParameter: (name, _index, fallback) =>
			({ text: 'answer from Agent', replyTo: event })[name] ?? fallback,
		getCredentials: async () => ({ botId: 'my-bot', botToken: 'token', ownerUserId: 'owner' }),
		getExecutionCancelSignal: () => undefined,
		getNode: () => ({ name: 'Weixin Chat' }),
	};
	const chat = new WeixinChat();
	await chat.execute.call(context);
	assert.equal(requests[0].msg.context_token, 'original-context');
	assert.equal(requests[0].msg.item_list[0].text_item.text, 'answer from Agent');
	event.botId = 'other-bot';
	await assert.rejects(() => chat.execute.call(context), /Bot ID must match/);
	assert.equal(requests.length, 1);
});

test('attachment mapping preserves the filename and requires no Bot credential', async (t) => {
	t.mock.method(globalThis, 'fetch', async () => new Response(Buffer.from('image')));
	const attachment = { type: 'image', url: 'https://novac2c.cdn.weixin.qq.com/c2c/download', fileName: 'photo.png' };
	const output = await new Weixin().execute.call({
		getNode: () => ({ name: 'Weixin' }),
		getInputData: () => [{ json: { attachments: [attachment] } }],
		getExecutionCancelSignal: () => undefined,
		getNodeParameter: (name, _index, fallback) => ({ operation: 'download', attachment })[name] ?? fallback,
		helpers: { prepareBinaryData: async (_data, fileName) => ({ fileName }) },
	});
	assert.equal(output[0][0].binary.data.fileName, 'photo.png');
});

test('an unrecognized Bot API host is rejected before sending a token', async (t) => {
	const { botRequest } = require('../dist/nodes/shared/api.js');
	const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected request'); });
	await assert.rejects(() => botRequest({ baseUrl: 'https://example.com', botToken: 'token' }, 'sendmessage', {}), /requires an HTTPS address under weixin.qq.com/);
	assert.equal(fetch.mock.callCount(), 0);
});
