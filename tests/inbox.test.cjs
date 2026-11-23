const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { WeixinTrigger } = require('../dist/nodes/WeixinTrigger/WeixinTrigger.node.js');
const { WeixinChatTrigger } = require('../dist/nodes/WeixinChatTrigger/WeixinChatTrigger.node.js');
const { dispatchReply, messageKey, parseCommand, registerReplyWaiter } = require('../dist/nodes/shared/inbox.js');

const account = { botId: 'test-bot', botToken: 'test-token', ownerUserId: 'owner' };

function context(command, manual = false) {
	const output = [];
	const errors = [];
	return {
		output,
		errors,
		getMode: () => (manual ? 'manual' : 'trigger'),
		getNodeParameter: (name, fallback) => ({ command, sessionMode: 'persistent', enableNewCommand: true, includeNewCommand: false })[name] ?? fallback,
		getCredentials: async () => account,
		getNode: () => ({ name: 'test', type: 'test', typeVersion: 1, position: [0, 0] }),
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
	global.fetch = async (_url, options) => {
		calls++;
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
		const chat = context();
		for (const [node, ctx] of [
			[new WeixinTrigger(), weather],
			[new WeixinTrigger(), todo],
			[new WeixinTrigger(), manual],
			[new WeixinChatTrigger(), chat],
		])
			handles.push(await node.trigger.call(ctx));
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
					message_id: '1',
					from_user_id: 'owner',
					message_type: 1,
					context_token: 'ctx',
					item_list: [{ type: 1, text_item: { text: '/WEATHER 上海' } }],
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
		await waitFor(() => weather.output.length === 1 && chat.output.length === 2 && pending);
		assert.equal(weather.output.length, 1);
		assert.equal(weather.output[0].args, '上海');
		assert.equal(weather.output[0].contextToken, 'ctx');
		assert.equal(manual.output.length, 1);
		assert.equal(todo.output[0].args, '买牛奶');
		assert.equal(chat.output[0].chatInput, '/WEATHER 上海');
		assert.equal(chat.output[0].sessionId, 'test-bot:owner:0');
		assert.equal(chat.output[0].contextToken, 'ctx');
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
					item_list: [{ type: 2, image_item: {} }],
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
		await waitFor(() => chat.output.length === 6 && pending);
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

test('uses item message IDs for deduplication and dispatches waiters in registration order', async () => {
	assert.deepEqual(parseCommand('/new'), { command: 'new', args: '' });
	assert.equal(messageKey({ from_user_id: 'user', item_list: [{ msg_id: 'item-1' }] }), '["user","item-1"]');
	const calls = [];
	const releaseFirst = registerReplyWaiter('fifo-bot', 'user', async (message) => calls.push(`first:${message.text}`));
	const releaseSecond = registerReplyWaiter('fifo-bot', 'user', async (message) => calls.push(`second:${message.text}`));
	try {
		assert.equal(await dispatchReply('fifo-bot', 'user', { text: 'one' }), true);
		assert.equal(await dispatchReply('fifo-bot', 'user', { text: 'two' }), true);
		assert.equal(await dispatchReply('fifo-bot', 'user', { text: 'three' }), false);
		assert.deepEqual(calls, ['first:one', 'second:two']);
	} finally {
		releaseFirst();
		releaseSecond();
	}
});
