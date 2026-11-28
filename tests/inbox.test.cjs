const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { WeixinTrigger } = require('../dist/nodes/WeixinTrigger/WeixinTrigger.node.js');
const { WeixinChatTrigger } = require('../dist/nodes/WeixinChatTrigger/WeixinChatTrigger.node.js');
const { assertCurrentChatSession, dispatchReply, messageKey, parseCommand, registerReplyWaiter } = require('../dist/nodes/shared/inbox.js');

const account = { botId: 'test-bot', botToken: 'test-token', ownerUserId: 'owner' };

function context(command, manual = false, typeVersion = 1, workflowId = 'primary') {
	const output = [];
	const errors = [];
	const messageErrors = [];
	return {
		output,
		errors,
		messageErrors,
		helpers: { prepareBinaryData: async () => { throw new Error("Unexpected binary data"); } },
		saveFailedExecution: (error) => messageErrors.push(error),
		getMode: () => (manual ? 'manual' : 'trigger'),
		getNodeParameter: (name, fallback) => ({ command, sessionMode: 'persistent', enableNewCommand: true, includeNewCommand: false })[name] ?? fallback,
		getWorkflow: () => ({ id: workflowId }),
		getCredentials: async () => account,
		getNode: () => ({ name: 'test', type: 'test', typeVersion, position: [0, 0] }),
		emit: (data) => output.push(data[0][0].json),
		emitError: (error) => errors.push(error),
	};
}

async function waitFor(check) {
	for (let i = 0; i < 100; i++) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error('Timed out waiting for message');
}

test('shares polling and routes commands through trigger lifecycles', async () => {
	const triggerProperties = new WeixinTrigger().description.properties;
	assert.deepEqual(triggerProperties.map((property) => property.name), ['command']);
	assert.equal(triggerProperties[0].required, true);
	const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'weixin-inbox-test-'));
	const originalFolder = process.env.N8N_USER_FOLDER;
	const originalFetch = global.fetch;
	process.env.N8N_USER_FOLDER = folder;
	let pending;
	let calls = 0;
	const sent = [];
	global.fetch = async (url, options) => {
		calls++;
		if (String(url).includes('sendmessage')) {
			sent.push(JSON.parse(options.body).msg.item_list[0].text_item.text);
			return { ok: true, text: async () => '{"ret":0}' };
		}
		const response = await new Promise((resolve, reject) => {
			pending = resolve;
			options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
		});
		return { ok: true, text: async () => JSON.stringify(response) };
	};
	const handles = [];
	try {
		assert.deepEqual(parseCommand('  /WEATHER   上海 浦东 '), {
			command: 'weather',
			args: '上海 浦东',
		});
		assert.equal(parseCommand('hello /weather'), undefined);
		const weather = context('weather');
		const todo = context('todo');
		const manual = context('weather', true);
		const chat = context('reading');
		const cooking = context('cooking');
		const testChat = context('preview', true);
		assert.equal(new WeixinChatTrigger().description.properties.find((property) => property.name === 'command').required, true);
		for (const [node, ctx] of [
			[new WeixinTrigger(), weather],
			[new WeixinTrigger(), todo],
			[new WeixinTrigger(), manual],
			[new WeixinChatTrigger(), chat],
			[new WeixinChatTrigger(), cooking],
			[new WeixinChatTrigger(), testChat],
		])
			handles.push(await node.trigger.call(ctx));
		await assert.rejects(() => new WeixinChatTrigger().trigger.call(context('READING')), /already registered/);
		await assert.rejects(() => new WeixinChatTrigger().trigger.call(context('weather')), /already registered/);
		await assert.rejects(
			() => new WeixinTrigger().trigger.call(context('WEATHER')),
			/already registered/,
		);
		await waitFor(() => pending);
		assert.equal(calls, 1);
		let send = pending;
		pending = undefined;
		send({
			ret: 0,
			get_updates_buf: 'cursor1',
			msgs: [
				{
					message_id: '0', from_user_id: 'owner', message_type: 1, context_token: 'ctx',
					item_list: [{ type: 1, text_item: { text: 'before selecting' } }],
				},
				{
					message_id: '0a', from_user_id: 'owner', message_type: 1, context_token: 'ctx',
					item_list: [{ type: 1, text_item: { text: '/unknown' } }],
				},
				{
					message_id: '1',
					from_user_id: 'owner',
					message_type: 1,
					context_token: 'ctx',
					item_list: [{ type: 1, text_item: { text: '/reading' } }],
				},
				{
					message_id: '1a',
					from_user_id: 'owner',
					message_type: 1,
					context_token: 'ctx',
					item_list: [{ type: 1, text_item: { text: '/weather 上海' } }],
				},
				{
					message_id: '2',
					from_user_id: 'owner',
					message_type: 1,
					item_list: [{ type: 1, text_item: { text: '/todo 买牛奶' } }],
				},
				{
					message_id: '3',
					from_user_id: 'other',
					message_type: 1,
					item_list: [{ type: 1, text_item: { text: '/weather ignored' } }],
				},
			],
		});
		await waitFor(() => weather.output.length === 1 && sent.length >= 3 && pending);
		assert.equal(weather.output.length, 1);
		assert.equal(weather.output[0].args, '上海');
		assert.equal(weather.output[0].contextToken, 'ctx');
		assert.equal(manual.output.length, 1);
		assert.equal(todo.output[0].args, '买牛奶');
		assert.equal(sent[0], '/cooking\n/reading');
		assert.ok(sent.includes('/reading'));
		assert.equal(chat.output.length, 0);
		await handles[0].closeFunction();
		await handles[2].closeFunction();
		send = pending;
		pending = undefined;
		send({
			ret: 0,
			get_updates_buf: 'cursor2',
			msgs: [
				{
					message_id: '4',
					from_user_id: 'owner',
					message_type: 1,
					item_list: [{ type: 1, text_item: { text: '/todo test' } }],
				},
			],
		});
		await waitFor(() => todo.output.length === 2 && pending);
		assert.equal(weather.output.length, 1);
		send = pending;
		pending = undefined;
		send({
			ret: 0,
			get_updates_buf: 'cursor3',
			msgs: [
				{
					message_id: '5',
					from_user_id: 'owner',
					message_type: 1,
					item_list: [{ type: 2, image_item: { media: { full_url: 'https://invalid.example/image' } } }],
				},
				{
					message_id: '6',
					from_user_id: 'owner',
					message_type: 1,
					item_list: [{ type: 1, text_item: { text: 'hello' } }],
				},
				{
					message_id: '7',
					from_user_id: 'owner',
					message_type: 1,
					item_list: [{ type: 3, voice_item: { text: 'voice transcript' } }],
				},
			],
		});
		await waitFor(() => chat.output.length === 3 && pending);
		assert.equal(chat.messageErrors.length, 1);
		assert.match(chat.messageErrors[0].message, /Unrecognized Weixin CDN address/);
		assert.equal(chat.output[1].chatInput, 'hello');
		assert.equal(chat.output[1].sessionId, 'test-bot:owner:reading:0');
		assert.equal(cooking.output.length, 0);
		send = pending;
		pending = undefined;
		const accepted = [];
		handles.push({ closeFunction: registerReplyWaiter('test-bot', 'owner', async (message) => {
			accepted.push(message.text);
		}) });
		send({
			ret: 0,
			get_updates_buf: 'cursor4',
			msgs: [
				{ message_id: '8', from_user_id: 'owner', message_type: 1, context_token: 'ctx', item_list: [{ type: 1, text_item: { text: '/cooking' } }] },
				{ message_id: '8a', from_user_id: 'owner', message_type: 1, item_list: [{ type: 1, text_item: { text: 'pending reply' } }] },
				{ message_id: '9', from_user_id: 'owner', message_type: 1, item_list: [{ type: 1, text_item: { text: 'food' } }] },
				{ message_id: '10', from_user_id: 'owner', message_type: 1, context_token: 'ctx', item_list: [{ type: 1, text_item: { text: '/reading' } }] },
				{ message_id: '10a', from_user_id: 'owner', message_type: 1, item_list: [{ type: 1, text_item: { text: '/preview' } }] },
				{ message_id: '11', from_user_id: 'owner', message_type: 1, item_list: [{ type: 1, text_item: { text: 'book' } }] },
				{ message_id: '12', from_user_id: 'owner', message_type: 1, context_token: 'ctx', item_list: [{ type: 1, text_item: { text: '/new' } }] },
				{ message_id: '13', from_user_id: 'owner', message_type: 1, item_list: [{ type: 1, text_item: { text: 'new book' } }] },
			],
		});
		await waitFor(() => chat.output.length >= 5 && sent.length >= 5);
		assert.deepEqual(accepted, ['pending reply']);
		assert.equal(cooking.output.length, 1);
		assert.equal(cooking.output[0].chatInput, 'food');
		assert.equal(cooking.output[0].sessionId, 'test-bot:owner:cooking:0');
		assert.equal(testChat.output.length, 0);
		assert.equal(chat.output[3].chatInput, 'book');
		assert.equal(chat.output[3].sessionId, 'test-bot:owner:reading:0');
		assert.equal(chat.output[4].sessionId, 'test-bot:owner:reading:1');
		assert.deepEqual(sent.slice(-4), ['/cooking', '/reading', '/cooking\n/reading', 'Started a new session.']);
		assert.equal(weather.output.length, 1);
		assert.equal(todo.output.length, 2);
		assert.equal(manual.output.length, 1);
		assert.equal(
			weather.errors.length + todo.errors.length + manual.errors.length,
			0,
		);
	} finally {
		for (const handle of handles) await handle.closeFunction();
		global.fetch = originalFetch;
		if (originalFolder === undefined) delete process.env.N8N_USER_FOLDER;
		else process.env.N8N_USER_FOLDER = originalFolder;
		fs.rmSync(folder, { recursive: true, force: true });
	}
});

test('uses item message IDs and allows only one pending wait per conversation', async () => {
	assert.deepEqual(parseCommand('/new'), { command: 'new', args: '' });
	assert.equal(messageKey({ from_user_id: 'user', item_list: [{ msg_id: 'item-1' }] }), '["user","item-1"]');
	const calls = [];
	const release = registerReplyWaiter('bot', 'user', async (message) => calls.push(message.text));
	try {
		assert.throws(() => registerReplyWaiter('bot', 'user', async () => {}), /already pending/);
		const first = dispatchReply('bot', 'user', { text: 'one' });
		assert.equal(await dispatchReply('bot', 'user', { text: 'two' }), false);
		assert.equal(await first, true);
		assert.deepEqual(calls, ['one']);
	} finally {
		release();
	}
});

test('primary chat starts directly and resets the session without resuming its old wait', async (t) => {
	const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'weixin-primary-test-'));
	const originalFolder = process.env.N8N_USER_FOLDER;
	process.env.N8N_USER_FOLDER = folder;
	const replies = [];
	let pending;
	t.mock.method(globalThis, 'fetch', async (url, options) => {
		if (String(url).endsWith('/sendmessage')) {
			replies.push(JSON.parse(options.body).msg.item_list[0].text_item.text);
			return { ok: true, text: async () => '{"ret":0}' };
		}
		const response = await new Promise((resolve, reject) => {
			pending = resolve;
			options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
		});
		return { ok: true, text: async () => JSON.stringify(response) };
	});
	const handles = [];
	const node = new WeixinChatTrigger();
	const primary = context('', false, 2);
	function message(id, text, extra = []) {
		return {
			message_id: id, from_user_id: 'owner', message_type: 1, context_token: 'ctx',
			item_list: [{ type: 1, text_item: { text } }, ...extra],
		};
	}
	async function push(cursor, msgs) {
		await waitFor(() => pending);
		const send = pending;
		pending = undefined;
		send({ ret: 0, get_updates_buf: cursor, msgs });
	}
	try {
		handles.push(await node.trigger.call(primary));
		await assert.rejects(() => node.trigger.call(context('', false, 2, 'other')), /only active/);
		await assert.rejects(() => node.trigger.call(context('legacy')), /only active/);
		const ordinary = context('weather');
		handles.push(await new WeixinTrigger().trigger.call(ordinary));
		await push('one', [
			message('1', 'hello'),
			message('2', '/new with arguments'),
			message('3', '/new', [{ type: 2, image_item: {} }]),
			message('4', '/weather'),
		]);
		await waitFor(() => primary.output.length === 3 && ordinary.output.length === 1);
		assert.deepEqual(primary.output.map((item) => item.chatInput), ['hello', '/new with arguments', '/new']);
		assert.equal(primary.output[0].sessionId, 'test-bot:owner:workflow:primary:0');
		assert.equal(primary.output[2].sessionId, primary.output[0].sessionId);
		assert.deepEqual(replies, []);

		let resumed = 0;
		let invalidated = 0;
		const oldSession = primary.output[0].weixinSession;
		const release = registerReplyWaiter(
			account.botId, account.ownerUserId, async () => { resumed++; }, oldSession,
			() => { invalidated++; },
		);
		handles.push({ closeFunction: release });
		const reset = message('5', ' /NEW ');
		await push('two', [reset, reset, message('6', 'next turn')]);
		await waitFor(() => primary.output.length === 4 && pending);
		assert.equal(resumed, 0);
		assert.equal(invalidated, 1);
		assert.deepEqual(replies, ['Started a new session.']);
		assert.equal(primary.output[3].chatInput, 'next turn');
		assert.equal(primary.output[3].sessionId, 'test-bot:owner:workflow:primary:1');
		await assert.rejects(() => assertCurrentChatSession(account.botId, oldSession), /already been reset/);
		await assertCurrentChatSession(account.botId, primary.output[3].weixinSession);

		await Promise.all(handles.splice(0).map((handle) => handle.closeFunction()));
		pending = undefined;
		handles.push(await node.trigger.call(primary));
		await push('three', [reset, message('7', 'after restart')]);
		await waitFor(() => primary.output.length === 5);
		assert.equal(primary.output[4].sessionId, primary.output[3].sessionId);
		assert.deepEqual(replies, ['Started a new session.']);
	} finally {
		for (const handle of handles) await handle.closeFunction();
		if (originalFolder === undefined) delete process.env.N8N_USER_FOLDER;
		else process.env.N8N_USER_FOLDER = originalFolder;
		fs.rmSync(folder, { recursive: true, force: true });
	}
});

test('different sessions can wait at once and an active session takes precedence over an account wait', async () => {
	const a = { key: 'a', generation: 0 };
	const b = { key: 'b', generation: 0 };
	const replies = [];
	const removals = [a, b, undefined].map((session) => registerReplyWaiter(
		'scoped-bot', 'user', async (message) => { replies.push([session?.key, message.text]); }, session,
	));
	try {
		assert.equal(await dispatchReply('scoped-bot', 'user', { text: 'second' }, undefined, b), true);
		assert.equal(await dispatchReply('scoped-bot', 'user', { text: 'first' }, undefined, a), true);
		assert.equal(await dispatchReply('scoped-bot', 'user', { text: 'account' }, undefined, b), true);
		assert.deepEqual(replies, [['b', 'second'], ['a', 'first'], [undefined, 'account']]);
	} finally {
		for (const remove of removals) remove();
	}
});
