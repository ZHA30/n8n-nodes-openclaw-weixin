const assert = require('node:assert/strict');
const test = require('node:test');
const { Weixin } = require('../dist/nodes/Weixin/Weixin.node.js');

test('resolves optional recipient and context for each send', async () => {
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
		await new Weixin().execute.call(
			context({
				operation: 'text',
				text: 'hello',
				options: { toUserId: 'other', contextToken: 'explicit' },
			}),
		);
		assert.equal(requests[1].msg.to_user_id, 'other');
		assert.equal(requests[1].msg.context_token, 'explicit');
		await new Weixin().execute.call(
			context({ operation: 'text', text: 'hello', options: { toUserId: 'other' } }),
		);
		assert.equal('context_token' in requests[2].msg, false);
		await assert.rejects(
			() =>
				new Weixin().execute.call(
					context({ operation: 'text', text: 'hello' }, { botId: 'bot', botToken: 'token' }),
				),
			/Provide toUserId/,
		);
	} finally {
		global.fetch = oldFetch;
	}
});

test('n8n preserves removable options', () => {
	const { NodeHelpers } = require('n8n-workflow');
	const description = new Weixin().description;
	for (const operation of ['text', 'image']) {
		const normalize = (values) =>
			NodeHelpers.getNodeParameters(
				description.properties,
				values,
				true,
				false,
				{ typeVersion: 1 },
				description,
			);
		const result = normalize({
			operation,
			options: { toUserId: 'new', contextToken: 'newToken' },
		});
		assert.deepEqual(result.options, { toUserId: 'new', contextToken: 'newToken' });
		assert.deepEqual(normalize({ operation, options: {} }).options, {});
	}
});
