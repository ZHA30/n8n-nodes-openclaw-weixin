import { configWithoutCloudSupport } from '@n8n/node-cli/eslint';

export default [
	...configWithoutCloudSupport,
	{ files: ['package.json'], rules: { '@n8n/community-nodes/no-runtime-dependencies': 'off' } },
	{ files: ['nodes/Weixin/**'], rules: { '@n8n/community-nodes/node-usable-as-tool': 'off' } },
	{ files: ['credentials/**'], rules: { '@n8n/community-nodes/credential-test-required': 'off' } },
	{
		files: ['nodes/WeixinLoginTrigger/**'],
		rules: { '@n8n/community-nodes/webhook-lifecycle-complete': 'off' },
	},
	{
		files: ['nodes/shared/**', 'nodes/WeixinTrigger/**'],
		rules: { '@n8n/community-nodes/require-node-api-error': 'off' },
	},
];
