import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

/**
 * One credential for both nodes.
 *
 * The key signs every call the Jabee node makes. The signing secret is
 * only read by the Jabee Trigger node, which makes no calls at all -- it
 * verifies the HMAC on a delivery Jabee posted to n8n. Two credentials
 * would have meant setting the same account up twice to use one product,
 * so they share one, and the secret is optional for anybody who never
 * adds the trigger.
 */
export class JabeeApi implements ICredentialType {
	name = 'jabeeApi';

	displayName = 'Jabee API';

	documentationUrl = 'https://jabee.ai/docs/n8n/';

	/** Its own copy, because n8n resolves `file:` against this directory. */
	icon: Icon = { light: 'file:icons/jabee.svg', dark: 'file:icons/jabee.dark.svg' };

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			placeholder: 'jak_...',
			description:
				'Made in the Jabee dashboard under Management then Approvals. It begins jak_ and is shown once.',
		},
		{
			displayName: 'Webhook Signing Secret',
			name: 'webhookSecret',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			placeholder: 'whsec_...',
			description:
				'Shown beside the webhook address in Jabee under Management then Approvals. Only the Jabee Trigger node reads it, to check the signature on each delivery. Leave it empty if you are not using the trigger.',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://api.jabee.ai/api/v1',
			description:
				'Change this only when pointing the node at a different Jabee deployment, such as a local one',
		},
	];

	/**
	 * The key goes in the header, never in the query string: a URL
	 * carrying a credential reaches proxy logs, and a leaked key here can
	 * send WhatsApp messages.
	 */
	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	/**
	 * The cheapest call that proves the key: listing one approval reads
	 * nothing anybody has to have created, costs no allowance, and sends
	 * no WhatsApp message. Creating a test request would have messaged a
	 * real handset every time somebody pressed the button.
	 */
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/approvals',
			method: 'GET',
			qs: { limit: 1 },
		},
	};
}
