import type {
	IDataObject,
	IHookFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { jabeeApiRequest } from './GenericFunctions';
import { DEFAULT_TOLERANCE_SECONDS, verifySignature } from './signature';

/**
 * The other direction: Jabee calling n8n.
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
 *
 * **One address per account, and this node registers it.** Jabee posts
 * every event for the whole business to one address, which is why
 * `create` refuses to replace somebody else's rather than quietly taking
 * the deliveries: see `webhookMethods` below. Activating this workflow
 * also replaces the account's signing secret -- Jabee rotates it on every
 * address change, so a repointed webhook can never be a silent one -- and
 * the new secret is kept in this node's static data, which is why the
 * credential's Webhook Signing Secret is optional now and only needed
 * when the address was set by hand on the dashboard instead.
 */
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
					'This workflow is registered as the account’s webhook address, and every event for the whole business arrives here. Jabee replaced the signing secret when it registered, so anything that was listening on the old address has stopped verifying.',
				inactive:
					'Activating this workflow registers it as the account’s webhook address and replaces the signing secret. Jabee allows one address per account, so activation is refused if a different one is already set — remove it under Management then Approvals first.',
			},
			activationHint:
				'Activating registers this URL with Jabee and messages the verified handset to say the address changed.',
		},
		properties: [
			{
				displayName:
					'Activating this workflow registers it as the account’s one webhook address and replaces the signing secret, and the verified handset is messaged to say so. If the address was set by hand on the Approvals page instead, put that whsec_ secret on the credential.',
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

	/**
	 * Registering this URL with Jabee, over the same `/api/v1` the rest of
	 * the package uses (`GET`, `PUT` and `DELETE /webhook`).
	 *
	 * Three things about this are not the usual shape, and all three come
	 * from Jabee having **one webhook address per account** rather than one
	 * per subscription:
	 *
	 *  - `create` **refuses to replace a different address**. n8n's
	 *    lifecycle would happily overwrite it, and overwriting it would
	 *    silently stop the deliveries whatever was there is relying on --
	 *    another workflow, or a server set up on the dashboard. A failed
	 *    activation with a sentence saying what to remove is the lesser
	 *    harm by a long way.
	 *  - `delete` **only removes the address when it is this URL**, for the
	 *    same reason in reverse: deactivating a workflow must not take down
	 *    an endpoint it never registered.
	 *  - `create` keeps the signing secret Jabee hands back in this node's
	 *    static data. Jabee rotates the secret on every address change --
	 *    which is what makes a repointed webhook impossible to do quietly
	 *    -- so the secret that was on the credential a moment ago is no
	 *    longer the live one. There is no route that reads a secret back,
	 *    by design, so the one chance to keep it is here.
	 */
	webhookMethods = {
		default: {
			/**
			 * True only when Jabee is already pointed here *and* we hold a
			 * secret to verify with. Without the second half, activation
			 * would look complete and every delivery would be refused 401.
			 */
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const mine = this.getNodeWebhookUrl('default');
				if (!mine) return false;
				const current = await readAddress.call(this);
				if (current !== mine) return false;
				return await haveSecret.call(this);
			},

			async create(this: IHookFunctions): Promise<boolean> {
				const mine = this.getNodeWebhookUrl('default');
				if (!mine) {
					throw new NodeOperationError(this.getNode(), 'This trigger has no webhook URL yet', {
						description: 'Save the workflow and activate it again.',
					});
				}

				const current = await readAddress.call(this);
				if (current && current !== mine) {
					throw new NodeOperationError(
						this.getNode(),
						`Jabee already posts to ${hostOf(current)}`,
						{
							description:
								'A Jabee account has one webhook address and this would take it over, so nothing was changed. Remove the address under Management then Approvals in the Jabee dashboard — or send DELETE /api/v1/webhook with the same key — and activate this workflow again. If that address was this workflow on a previous URL, remove it the same way.',
						},
					);
				}

				const answer = await jabeeApiRequest.call(this, 'PUT', '/webhook', { url: mine });
				const secret = typeof answer.secret === 'string' ? answer.secret : '';
				const stored = this.getWorkflowStaticData('node');
				if (secret) stored.webhookSecret = secret;
				else delete stored.webhookSecret;
				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				const mine = this.getNodeWebhookUrl('default');
				const stored = this.getWorkflowStaticData('node');
				const current = await readAddress.call(this);

				/**
				 * Not ours, or already gone. Answered true either way:
				 * n8n reads false as a failed deactivation, and there is
				 * nothing here for anybody to retry.
				 */
				if (!current || current !== mine) {
					if (current) {
						this.logger.warn(
							`Jabee Trigger left the webhook address alone: it points at ${hostOf(current)}, not at this workflow`,
						);
					}
					delete stored.webhookSecret;
					return true;
				}

				await jabeeApiRequest.call(this, 'DELETE', '/webhook');
				delete stored.webhookSecret;
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const credentials = await this.getCredentials('jabeeApi');
		const options = this.getNodeParameter('options', {}) as IDataObject;
		const events = this.getNodeParameter('events', []) as string[];

		/**
		 * Two secrets can both be legitimate, so both are tried.
		 *
		 * The one this node was handed when it registered the address is
		 * the live one in the ordinary case. The one pasted on the
		 * credential is the live one when the address was set by hand on
		 * the dashboard. Which of the two applies is not knowable from
		 * here -- a change on either side rotates or does not -- and
		 * trying the second after the first fails costs one HMAC of a
		 * body we have already read.
		 */
		const registered = this.getWorkflowStaticData('node').webhookSecret;
		const secrets = [
			typeof registered === 'string' ? registered : '',
			String(credentials.webhookSecret ?? ''),
		].filter((one) => one.length > 0);

		/**
		 * A misconfiguration rather than a bad request, so it is said as
		 * one. Refusing everything with a 401 would have looked like Jabee
		 * being wrong, and the fix is on the credential.
		 */
		if (secrets.length === 0) {
			throw new NodeOperationError(
				this.getNode(),
				'Add the webhook signing secret to the Jabee credential',
				{
					description:
						'Activating this workflow normally registers the address and keeps the secret itself. Set it by hand only when the address was set on the Approvals page instead: it begins whsec_ and is shown beside the address there. Without it a delivery cannot be told apart from anybody who found this URL.',
				},
			);
		}

		const request = this.getRequestObject();
		const headers = this.getHeaderData();
		const checks = secrets.map((secret) =>
			verifySignature({
				header: singleHeader(headers['x-jabee-signature']),
				rawBody: request.rawBody ?? '',
				secret,
				nowSeconds: Math.floor(Date.now() / 1000),
				...(typeof options.tolerance === 'number' ? { toleranceSeconds: options.tolerance } : {}),
			}),
		);
		const check = checks.find((one) => one.ok) ?? checks[0]!;

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

/** Where Jabee posts for this account, or null when it posts nowhere. */
async function readAddress(this: IHookFunctions): Promise<string | null> {
	const answer = await jabeeApiRequest.call(this, 'GET', '/webhook');
	const webhook = (answer.webhook ?? {}) as IDataObject;
	return typeof webhook.url === 'string' && webhook.url.length > 0 ? webhook.url : null;
}

/** Whether a delivery could be verified at all, from either place one is kept. */
async function haveSecret(this: IHookFunctions): Promise<boolean> {
	const registered = this.getWorkflowStaticData('node').webhookSecret;
	if (typeof registered === 'string' && registered.length > 0) return true;
	const credentials = await this.getCredentials('jabeeApi');
	return String(credentials.webhookSecret ?? '').length > 0;
}

/**
 * The host of an address, for a message about it.
 *
 * The path is often the whole of what makes a webhook URL secret, and
 * this one goes into an n8n error that anybody who can open the workflow
 * can read.
 */
function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return 'another address';
	}
}
