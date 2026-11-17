import type {
	IDataObject,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { DEFAULT_TOLERANCE_SECONDS, verifySignature } from './signature';

/**
 * The other direction: Jabee calling n8n.
 *
 * Jabee's webhook address is one setting on the account, not something a
 * single execution hands out, so this trigger cannot register itself the
 * way a Stripe or GitHub trigger does -- there is no API for it, by
 * design: the address and its signing secret are set by a person who is
 * signed in, on the Approvals page. You paste the Production URL below
 * into that field once, and every account event arrives here.
 *
 * Which makes this the right node for an approval that takes hours. The
 * Jabee node's "Wait for the Answer" holds an execution open while it
 * polls; this holds nothing open at all, and a workflow started by
 * `approval.answered` can read `metadata` to find what it was about.
 *
 * `message.received` is the half of the API that has no counterpart
 * anywhere else: words a verified handset typed on the WhatsApp thread,
 * delivered to this workflow. A reply from a phone can therefore be an
 * instruction, on a number nobody had to buy.
 */
/**
 * No `webhookMethods`, and it is not an omission.
 *
 * `checkExists`, `create` and `delete` need an API that registers a
 * webhook address. Jabee has none: the address and its signing secret are
 * set on the Approvals page by a person who is signed in, deliberately --
 * a `jak_` key that could repoint where answers are delivered would make
 * a leaked key worth far more than the messages it can send. So this
 * trigger is registered by hand, the way n8n's own Webhook node is, and
 * the notice in the panel says where to paste the URL.
 *
 * The rule is suppressed rather than satisfied because satisfying it
 * would mean inventing an endpoint. If Jabee ever gains a key-authenticated
 * route for the webhook address, delete this and implement the three.
 */
// eslint-disable-next-line @n8n/community-nodes/webhook-lifecycle-complete
export class JabeeTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Jabee Trigger',
		name: 'jabeeTrigger',
		icon: { light: 'file:jabee.svg', dark: 'file:jabee.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["events"].join(", ")}}',
		description: 'Starts a workflow when a person answers on WhatsApp, or types something back',
		defaults: {
			name: 'Jabee Trigger',
		},
		/** Inline for the reason given in `Jabee.node.ts`: a codex file
		 * beside the source is not copied into `dist` by the build. */
		codex: {
			categories: ['Communication', 'Utility'],
			resources: {
				primaryDocumentation: [{ url: 'https://jabee.ai/docs/n8n/#trigger' }],
				credentialDocumentation: [{ url: 'https://jabee.ai/docs/n8n/#credential' }],
			},
			alias: ['WhatsApp', 'Approval', 'Human in the loop', 'Webhook'],
		},
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'jabeeApi',
				required: true,
			},
		],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'webhook',
			},
		],
		triggerPanel: {
			header: 'Waiting for Jabee',
			executionsHelp: {
				active:
					'Jabee posts every event for the whole account to one address. Paste the Production URL above into the Jabee dashboard under Management then Approvals, as the webhook address, and copy the whsec_ secret it shows into the Webhook Signing Secret field on this node’s credential.',
				inactive:
					'Jabee posts every event for the whole account to one address. Activate this workflow, then paste the Production URL above into the Jabee dashboard under Management then Approvals, as the webhook address, and copy the whsec_ secret it shows into the Webhook Signing Secret field on this node’s credential.',
			},
			activationHint:
				'Deliveries are only accepted once the signing secret is on the credential, so set it before testing.',
		},
		properties: [
			{
				displayName:
					'Jabee sends every event for the account to one address, so paste the URL above into Management then Approvals in the Jabee dashboard. This node cannot register itself.',
				name: 'setupNotice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				required: true,
				default: ['approval.answered'],
				description: 'Which deliveries start this workflow. The rest are answered 200 and dropped.',
				options: [
					{
						name: 'Approval Answered',
						value: 'approval.answered',
						description: 'Somebody tapped Approve, Skip or Edit. Alerts arrive here too, acknowledged.',
					},
					{
						name: 'Approval Expired',
						value: 'approval.expired',
						description: 'Nobody answered before the request ran out of time',
					},
					{
						name: 'Approval Failed',
						value: 'approval.failed',
						description: 'It could not be delivered to anybody',
					},
					{
						name: 'Message Received',
						value: 'message.received',
						description:
							'The verified handset typed something that was not a button and not a stop word',
					},
					{
						name: 'Test',
						value: 'approval.test',
						description: 'The Send test button on the Jabee webhook settings',
					},
				],
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Signature Tolerance (Seconds)',
						name: 'tolerance',
						type: 'number',
						typeOptions: { minValue: 10, maxValue: 3600 },
						default: DEFAULT_TOLERANCE_SECONDS,
						description:
							'How far the signature’s timestamp may be from this machine’s clock. Raise it only if the two clocks genuinely drift; a wide tolerance is how long a captured delivery stays replayable.',
					},
					{
						displayName: 'Include Headers',
						name: 'includeHeaders',
						type: 'boolean',
						default: false,
						description:
							'Whether to add the request headers to the output under "headers". The delivery ID is already on the item, so this is only for debugging.',
					},
				],
			},
		],
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const credentials = await this.getCredentials('jabeeApi');
		const secret = String(credentials.webhookSecret ?? '');
		const options = this.getNodeParameter('options', {}) as IDataObject;
		const events = this.getNodeParameter('events', []) as string[];

		/**
		 * A misconfiguration rather than a bad request, so it is said as
		 * one. Refusing everything with a 401 would have looked like Jabee
		 * being wrong, and the fix is on the credential.
		 */
		if (!secret) {
			throw new NodeOperationError(
				this.getNode(),
				'Add the webhook signing secret to the Jabee credential',
				{
					description:
						'It begins whsec_ and is shown beside the webhook address in the Jabee dashboard under Management then Approvals. Without it a delivery cannot be told apart from anybody who found this URL.',
				},
			);
		}

		const request = this.getRequestObject();
		const headers = this.getHeaderData();
		const check = verifySignature({
			header: singleHeader(headers['x-jabee-signature']),
			rawBody: request.rawBody ?? '',
			secret,
			nowSeconds: Math.floor(Date.now() / 1000),
			...(typeof options.tolerance === 'number' ? { toleranceSeconds: options.tolerance } : {}),
		});

		if (!check.ok) {
			/**
			 * 401 and nothing else. Jabee retries a failure on its own
			 * ladder for about eleven hours, which is exactly what should
			 * happen while somebody fixes the secret, and saying which
			 * check failed in the response body would help an attacker
			 * more than it helps the owner -- the reason goes in the n8n
			 * log instead.
			 */
			this.logger.warn(`Jabee Trigger refused a delivery: ${check.reason}`);
			const response = this.getResponseObject();
			response.status(401).send('Unauthorized').end();
			return { noWebhookResponse: true };
		}

		const body = this.getBodyData();
		const event = String(body.event ?? headers['x-jabee-event'] ?? '');

		/**
		 * Not this workflow's event. Answered 2xx rather than refused:
		 * every account event goes to the one address, so a workflow that
		 * only wants answers must not teach Jabee to retry the expiries
		 * for eleven hours.
		 */
		if (!events.includes(event)) {
			return { webhookResponse: 'ignored' };
		}

		const item: IDataObject = {
			...body,
			...(options.includeHeaders === true ? { headers } : {}),
		};

		return {
			workflowData: [this.helpers.returnJsonArray([item])],
		};
	}
}

/** A header as one value, since Node hands repeated headers over as a list. */
function singleHeader(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}
