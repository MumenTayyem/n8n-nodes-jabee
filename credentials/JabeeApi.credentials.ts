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
 * The key signs every call the Jabee node makes, and the trigger's own
 * `webhookMethods` register the address with it on activation. The signing
 * secret field is the fallback for the other way of setting that address,
 * by hand on the Approvals page: a trigger that registered itself was
 * handed a fresh secret and keeps it in its own static data, because Jabee
 * rotates the secret on every address change and has no route that reads
 * one back. Two credentials would have meant setting the same account up
 * twice to use one product, so they share one.
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
				'Only needed when the webhook address was set by hand on the Approvals page: activating the Jabee Trigger registers the address itself and keeps the secret Jabee hands back. Only the trigger reads it, to check the signature on each delivery.',
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
