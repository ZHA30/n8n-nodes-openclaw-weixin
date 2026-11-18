const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { WeixinTrigger } = require('../dist/nodes/WeixinTrigger/WeixinTrigger.node.js');
const { parseCommand } = require('../dist/nodes/shared/inbox.js');

const account = { botId: 'test-bot', botToken: 'test-token', ownerUserId: 'owner' };

function context(event = 'all', command, manual = false, excludeCommands = false) {
	const output = [];
	const errors = [];
	return {
		output,
		errors,
		getMode: () => (manual ? 'manual' : 'trigger'),
		getNodeParameter: (name, fallback) => ({ event, command, excludeCommands })[name] ?? fallback,
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
		const all = context();
		const weather = context('command', 'weather');
		const todo = context('command', 'todo');
		const manual = context('command', 'weather', true);
		const manualAll = context('all', undefined, true);
		const image = context('image');
		const text = context('text', undefined, false, true);
		for (const [node, ctx] of [
			[new WeixinTrigger(), all],
			[new WeixinTrigger(), weather],
			[new WeixinTrigger(), todo],
			[new WeixinTrigger(), manual],
			[new WeixinTrigger(), image],
			[new WeixinTrigger(), text],
			[new WeixinTrigger(), manualAll],
		])
			handles.push(await node.trigger.call(ctx));
		await assert.rejects(
			() => new WeixinTrigger().trigger.call(context('command', 'WEATHER')),
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
		await waitFor(() => all.output.length === 2 && pending);
		assert.equal(weather.output.length, 1);
		assert.equal(weather.output[0].args, '上海');
		assert.equal(weather.output[0].contextToken, 'ctx');
		assert.equal(manual.output.length, 1);
		assert.equal(manualAll.output.length, 2);
		assert.equal(image.output.length, 0);
		assert.equal(text.output.length, 0);
		assert.equal(todo.output[0].args, '买牛奶');
		await handles[1].closeFunction();
		await handles[3].closeFunction();
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
		assert.equal(all.output.length, 3);
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
		await waitFor(() => all.output.length === 6 && pending);
		assert.equal(image.output.length, 1);
		assert.equal(text.output.length, 1);
		assert.equal(text.output[0].text, 'hello');
		assert.equal(
			all.errors.length + weather.errors.length + todo.errors.length + manual.errors.length,
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
