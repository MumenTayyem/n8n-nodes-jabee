import type {
	IDataObject,
	IExecuteFunctions,
	INode,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { jabeeApiRequest, waitForAnswer } from './GenericFunctions';

/**
 * Jabee on WhatsApp, from a workflow.
 *
 * Two things this does that an HTTP Request node pointed at the same API
 * does not. It waits: "Request Approval" can hold the item until a person
 * taps Approve on their phone, which is the whole reason to put a human
 * in a workflow at all. And it reads Jabee's refusals out loud -- a
 * monthly allowance that is used up, a request that is closed, a daily
 * cap -- rather than handing back a status code.
 *
 * What it cannot do is message your customers. The number and the
 * approved template belong to Jabee, and a shared sender reaching
 * strangers is what gets numbers banned, so delivery goes to the one
 * handset the business verified. That trade is why no WhatsApp Business
 * account is needed at either end.
 */
export class Jabee implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Jabee',
		name: 'jabee',
		icon: { light: 'file:jabee.svg', dark: 'file:jabee.dark.svg' },
		group: ['output'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Ask a person on WhatsApp before acting, and send alerts, without owning a number',
		defaults: {
			name: 'Jabee',
		},
		/**
		 * Inline rather than in a `Jabee.node.json` beside this file.
		 *
		 * The convention is the separate codex file, and the n8n starter
		 * ships one -- but `n8n-node build` copies only `**\/*.{png,svg}`
		 * and `__schema__` JSON into `dist`, so a codex file next to the
		 * source never reaches the published package and the node loads
		 * with no category and no documentation link. The description
		 * carries the same fields and is compiled, so it arrives.
		 */
		codex: {
			categories: ['Communication', 'Utility'],
			resources: {
				primaryDocumentation: [{ url: 'https://jabee.ai/docs/n8n/' }],
				credentialDocumentation: [{ url: 'https://jabee.ai/docs/n8n/#credential' }],
			},
			alias: ['WhatsApp', 'Approval', 'Human in the loop', 'Alert', 'Notification', 'Heartbeat'],
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [
			{
				name: 'jabeeApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Alert',
						value: 'alert',
						description: 'A notice on WhatsApp with nothing to answer',
					},
					{
						name: 'Approval',
						value: 'approval',
						description: 'A question on WhatsApp with buttons, and an answer to act on',
					},
					{
						name: 'Heartbeat',
						value: 'heartbeat',
						description: 'A check that alerts when this workflow stops running at all',
					},
				],
				default: 'approval',
			},

			// ---------------------------------------------------------------
			// Operations
			// ---------------------------------------------------------------
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['approval'] } },
				options: [
					{
						name: 'Cancel',
						value: 'cancel',
						action: 'Cancel an approval',
						description: 'Withdraw a request that is no longer needed',
					},
					{
						name: 'Get',
						value: 'get',
						action: 'Get an approval',
						description: 'Read one request back, including how it was answered',
					},
					{
						name: 'Get Many',
						value: 'getAll',
						action: 'Get many approvals',
						description: 'List requests, optionally only those that changed since a time',
					},
					{
						name: 'Report Outcome',
						value: 'reportOutcome',
						action: 'Report the outcome of an approval',
						description: 'Record what this workflow did once the answer came back',
					},
					{
						name: 'Request',
						value: 'request',
						action: 'Request an approval',
						description: 'Ask a person on WhatsApp to approve, skip or amend something',
					},
					{
						name: 'Revise',
						value: 'revise',
						action: 'Revise an approval',
						description: 'Put an amended request to the same person again',
					},
				],
				default: 'request',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['alert'] } },
				options: [
					{
						name: 'Send',
						value: 'send',
						action: 'Send an alert',
						description:
							'Send a notice on WhatsApp to the verified handset, with nothing to answer',
					},
				],
				default: 'send',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['heartbeat'] } },
				options: [
					{
						name: 'Check In',
						value: 'checkIn',
						action: 'Check in to a heartbeat',
						description: 'Tell Jabee this workflow ran, so silence past the deadline raises an alert',
					},
				],
				default: 'checkIn',
			},

			// ---------------------------------------------------------------
			// approval: request  /  alert: send
			// ---------------------------------------------------------------
			{
				displayName: 'Title',
				name: 'title',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'Refund 450 AED to Sara',
				description:
					'The one line the person reads first. At most 120 characters; longer is refused rather than trimmed, so slice anything built from data you do not control.',
				displayOptions: { show: { resource: ['approval', 'alert'], operation: ['request', 'send'] } },
			},
			{
				displayName: 'Body',
				name: 'body',
				type: 'string',
				typeOptions: { rows: 3 },
				default: '',
				description:
					'Everything they need in order to decide, or to understand the notice. At most 2000 characters. Sent verbatim; Jabee reads none of it.',
				displayOptions: { show: { resource: ['approval', 'alert'], operation: ['request', 'send'] } },
			},
			{
				displayName: 'Buttons',
				name: 'options',
				type: 'multiOptions',
				options: [
					{ name: 'Approve', value: 'approve' },
					{ name: 'Edit', value: 'edit' },
					{ name: 'Skip', value: 'skip' },
				],
				default: ['approve', 'skip'],
				required: true,
				description:
					'Which buttons the person gets, one to three of them. Edit asks for free text, which arrives in the response as the answer rather than on the WhatsApp thread.',
				displayOptions: { show: { resource: ['approval'], operation: ['request'] } },
			},
			{
				displayName: 'Wait for the Answer',
				name: 'wait',
				type: 'boolean',
				default: false,
				description:
					'Whether to hold this item until somebody answers. The execution stays open while it waits, so use the Jabee Trigger node instead when the answer may take hours.',
				displayOptions: { show: { resource: ['approval'], operation: ['request'] } },
			},
			{
				displayName: 'Wait Timeout (Seconds)',
				name: 'waitTimeout',
				type: 'number',
				typeOptions: { minValue: 5, maxValue: 3600 },
				default: 900,
				description:
					'How long to keep polling. Reaching it is not an error: the request comes back still pending, with its ID, and can be read later.',
				displayOptions: { show: { resource: ['approval'], operation: ['request'], wait: [true] } },
			},
			{
				displayName: 'Additional Fields',
				name: 'additionalFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: { show: { resource: ['approval', 'alert'], operation: ['request', 'send'] } },
				options: [
					{
						displayName: 'External ID',
						name: 'external_id',
						type: 'string',
						default: '',
						placeholder: 'refund-1043',
						description:
							'Your own ID for the thing being decided. Sending the same one twice returns the request already made instead of messaging anybody again, so a rerun or a retry branch is safe. Leave it out and every execution is a new message.',
					},
					{
						displayName: 'Link',
						name: 'url',
						type: 'string',
						default: '',
						placeholder: 'https://dashboard.example/invoices/1043',
						description: 'A full http or https address to the thing being decided',
					},
					{
						displayName: 'Expires In (Minutes)',
						name: 'expires_in_minutes',
						type: 'number',
						typeOptions: { minValue: 5, maxValue: 10080 },
						default: 1440,
						description:
							'When an unanswered request gives up, between 5 minutes and a week. Past a week the person has forgotten what it was about.',
					},
					{
						displayName: 'Metadata',
						name: 'metadata',
						type: 'json',
						default: '{}',
						description:
							'Anything this workflow needs handed back to it. Returned unchanged on every read and on the webhook, so it is where a payment ID or an execution ID belongs. At most 16KB.',
					},
				],
			},

			// ---------------------------------------------------------------
			// approval: get / revise / cancel / reportOutcome
			// ---------------------------------------------------------------
			{
				displayName: 'Approval ID',
				name: 'approvalId',
				type: 'string',
				default: '',
				required: true,
				description: 'The ID Jabee returned when the request was made',
				displayOptions: {
					show: {
						resource: ['approval'],
						operation: ['get', 'revise', 'cancel', 'reportOutcome'],
					},
				},
			},
			{
				displayName: 'Fields to Change',
				name: 'reviseFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				description:
					'Give at least one of Title, Body or Link. A request can only be revised after it was answered with Edit, and five times at most.',
				displayOptions: { show: { resource: ['approval'], operation: ['revise'] } },
				options: [
					{
						displayName: 'Title',
						name: 'title',
						type: 'string',
						default: '',
					},
					{
						displayName: 'Body',
						name: 'body',
						type: 'string',
						typeOptions: { rows: 3 },
						default: '',
					},
					{
						displayName: 'Link',
						name: 'url',
						type: 'string',
						default: '',
					},
					{
						displayName: 'Expires In (Minutes)',
						name: 'expires_in_minutes',
						type: 'number',
						typeOptions: { minValue: 5, maxValue: 10080 },
						default: 1440,
					},
				],
			},
			{
				displayName: 'Reason',
				name: 'reason',
				type: 'string',
				default: '',
				description:
					'Why it is being withdrawn, for whoever reads the history later. At most 200 characters; nothing acts on it.',
				displayOptions: { show: { resource: ['approval'], operation: ['cancel'] } },
			},
			{
				displayName: 'Outcome',
				name: 'outcome',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'refunded',
				description:
					'Your own word for what this workflow did, 1 to 40 characters of a-z, 0-9 and underscore. Jabee never reads it; it is how the dashboard shows that an approved request was actually acted on.',
				displayOptions: { show: { resource: ['approval'], operation: ['reportOutcome'] } },
			},
			{
				displayName: 'Note',
				name: 'note',
				type: 'string',
				default: '',
				description: 'A sentence of detail for a person reading the history. At most 500 characters.',
				displayOptions: { show: { resource: ['approval'], operation: ['reportOutcome'] } },
			},

			// ---------------------------------------------------------------
			// approval: getAll
			// ---------------------------------------------------------------
			{
				displayName: 'Return All',
				name: 'returnAll',
				type: 'boolean',
				default: false,
				description: 'Whether to return all results or only up to a given limit',
				displayOptions: { show: { resource: ['approval'], operation: ['getAll'] } },
			},
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 100 },
				default: 50,
				description: 'Max number of results to return',
				displayOptions: {
					show: { resource: ['approval'], operation: ['getAll'], returnAll: [false] },
				},
			},
			{
				displayName: 'Filters',
				name: 'filters',
				type: 'collection',
				placeholder: 'Add Filter',
				default: {},
				displayOptions: { show: { resource: ['approval'], operation: ['getAll'] } },
				options: [
					{
						displayName: 'Status',
						name: 'status',
						type: 'options',
						default: 'pending',
						options: [
							{ name: 'Approved', value: 'approved' },
							{ name: 'Cancelled', value: 'cancelled' },
							{ name: 'Edited', value: 'edited' },
							{ name: 'Expired', value: 'expired' },
							{ name: 'Failed', value: 'failed' },
							{ name: 'Pending', value: 'pending' },
							{ name: 'Skipped', value: 'skipped' },
						],
					},
					{
						displayName: 'Changed Since',
						name: 'since',
						type: 'dateTime',
						default: '',
						description:
							'Only requests that changed after this time, oldest first. Keep the last Updated At you saw and pass it back to poll for answers.',
					},
				],
			},

			// ---------------------------------------------------------------
			// heartbeat: checkIn
			// ---------------------------------------------------------------
			{
				displayName: 'Name',
				name: 'heartbeatName',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'nightly-sync',
				description:
					'1 to 60 characters of a-z, 0-9, - and _, starting with a letter or a digit. The first check-in registers the check; 20 per account.',
				displayOptions: { show: { resource: ['heartbeat'], operation: ['checkIn'] } },
			},
			{
				displayName: 'Every',
				name: 'every',
				type: 'string',
				default: '',
				placeholder: '15m',
				description:
					'How often this workflow runs: 90s, 15m, 2h, 1d, or plain seconds. Required on the first check-in, and the stored schedule is kept when later check-ins leave it out.',
				displayOptions: { show: { resource: ['heartbeat'], operation: ['checkIn'] } },
			},
			{
				displayName: 'Grace',
				name: 'grace',
				type: 'string',
				default: '',
				placeholder: '5m',
				description:
					'How late a run may be before Jabee raises an alert. Nothing set means no grace, which is the honest default.',
				displayOptions: { show: { resource: ['heartbeat'], operation: ['checkIn'] } },
			},
			{
				displayName: 'Alert on Recovery',
				name: 'recover',
				type: 'boolean',
				default: false,
				description:
					'Whether to also send a message when a missed check starts running again. Off by default, because a recovery doubles what an outage costs against the monthly allowance.',
				displayOptions: { show: { resource: ['heartbeat'], operation: ['checkIn'] } },
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returned: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const resource = this.getNodeParameter('resource', i) as string;
				const operation = this.getNodeParameter('operation', i) as string;
				const rows = await run.call(this, resource, operation, i);

				returned.push(
					...this.helpers.constructExecutionMetaData(this.helpers.returnJsonArray(rows), {
						itemData: { item: i },
					}),
				);
			} catch (error) {
				/**
				 * The one place a failure is allowed to be data. A workflow
				 * that asks about fifty invoices should not lose the other
				 * forty-nine because one ID was wrong.
				 */
				if (this.continueOnFail()) {
					returned.push({
						json: { error: (error as Error).message },
						pairedItem: { item: i },
					});
					continue;
				}
				/**
				 * Anything from this node is already a NodeApiError or a
				 * NodeOperationError, but a surprise from inside n8n's own
				 * HTTP helper is not, and n8n shows a bare Error without
				 * the node or the item it came from.
				 */
				throw asNodeError(this.getNode(), error, i);
			}
		}

		return [returned];
	}
}

/** Whatever came out of the try block, as something n8n can show. */
function asNodeError(node: INode, error: unknown, itemIndex: number): Error {
	if (error instanceof NodeApiError || error instanceof NodeOperationError) return error;
	return new NodeOperationError(node, error as Error, { itemIndex });
}

/** One item's worth of work, returning the rows it produced. */
async function run(
	this: IExecuteFunctions,
	resource: string,
	operation: string,
	i: number,
): Promise<IDataObject[]> {
	if (resource === 'alert' && operation === 'send') {
		return [await jabeeApiRequest.call(this, 'POST', '/alerts', createBody.call(this, i, false))];
	}

	if (resource === 'approval') {
		switch (operation) {
			case 'request': {
				const created = await jabeeApiRequest.call(
					this,
					'POST',
					'/approvals',
					createBody.call(this, i, true),
				);
				const wait = this.getNodeParameter('wait', i, false) as boolean;
				/**
				 * Nothing to wait for on a request that is already settled.
				 * An External ID that has been used before comes back with
				 * `existing: true` and whatever status it already had, and a
				 * delivery that reached nobody comes back `failed` -- in
				 * both cases the poll loop would only read the same row.
				 */
				if (!wait || created.status !== 'pending') return [created];

				const timeout = (this.getNodeParameter('waitTimeout', i, 900) as number) * 1_000;
				const id = String(created.id);
				const answered = await waitForAnswer(
					async () => jabeeApiRequest.call(this, 'GET', `/approvals/${encodeURIComponent(id)}`),
					timeout,
				);
				/**
				 * `existing` is on the create response and not on the read,
				 * so it is carried across rather than lost: a workflow
				 * branching on "did this message actually go out" needs it
				 * whether it waited or not.
				 */
				return [{ ...answered, existing: created.existing ?? false }];
			}

			case 'get': {
				const id = this.getNodeParameter('approvalId', i) as string;
				return [await jabeeApiRequest.call(this, 'GET', `/approvals/${encodeURIComponent(id)}`)];
			}

			case 'getAll':
				return await listApprovals.call(this, i);

			case 'revise': {
				const id = this.getNodeParameter('approvalId', i) as string;
				const fields = this.getNodeParameter('reviseFields', i, {}) as IDataObject;
				if (
					fields.title === undefined &&
					fields.body === undefined &&
					fields.url === undefined
				) {
					throw new NodeOperationError(
						this.getNode(),
						'Give a Title, a Body or a Link to change',
						{
							itemIndex: i,
							description:
								'Revising puts the request to the same person again, so at least one of the three has to be different. Expires In on its own is not a change they would see.',
						},
					);
				}
				return [
					await jabeeApiRequest.call(
						this,
						'POST',
						`/approvals/${encodeURIComponent(id)}/revise`,
						fields,
					),
				];
			}

			case 'cancel': {
				const id = this.getNodeParameter('approvalId', i) as string;
				const reason = this.getNodeParameter('reason', i, '') as string;
				return [
					await jabeeApiRequest.call(
						this,
						'POST',
						`/approvals/${encodeURIComponent(id)}/cancel`,
						reason ? { reason } : {},
					),
				];
			}

			case 'reportOutcome': {
				const id = this.getNodeParameter('approvalId', i) as string;
				const outcome = this.getNodeParameter('outcome', i) as string;
				const note = this.getNodeParameter('note', i, '') as string;
				return [
					await jabeeApiRequest.call(
						this,
						'POST',
						`/approvals/${encodeURIComponent(id)}/outcome`,
						{ outcome, ...(note ? { note } : {}) },
					),
				];
			}

			default:
				break;
		}
	}

	if (resource === 'heartbeat' && operation === 'checkIn') {
		const name = this.getNodeParameter('heartbeatName', i) as string;
		const every = this.getNodeParameter('every', i, '') as string;
		const grace = this.getNodeParameter('grace', i, '') as string;
		const recover = this.getNodeParameter('recover', i, false) as boolean;
		return [
			await jabeeApiRequest.call(
				this,
				'POST',
				`/heartbeat/${encodeURIComponent(name)}`,
				{},
				{
					...(every ? { every } : {}),
					...(grace ? { grace } : {}),
					...(recover ? { recover: 'true' } : {}),
				},
			),
		];
	}

	throw new NodeOperationError(
		this.getNode(),
		`The operation '${operation}' is not supported on '${resource}'`,
		{ itemIndex: i },
	);
}

/**
 * The body both creating calls share.
 *
 * An alert is the same request with the question taken out, so the schema
 * is this one without `options` -- which is also why the Buttons field is
 * hidden rather than sent as a single value nobody chose.
 */
function createBody(this: IExecuteFunctions, i: number, isApproval: boolean): IDataObject {
	const extra = this.getNodeParameter('additionalFields', i, {}) as IDataObject;
	const body: IDataObject = {
		title: this.getNodeParameter('title', i) as string,
	};

	const text = this.getNodeParameter('body', i, '') as string;
	if (text) body.body = text;

	if (isApproval) {
		body.options = this.getNodeParameter('options', i, ['approve', 'skip']) as string[];
	}

	if (extra.external_id) body.external_id = extra.external_id;
	if (extra.url) body.url = extra.url;
	if (extra.expires_in_minutes !== undefined) {
		body.expires_in_minutes = extra.expires_in_minutes;
	}
	if (extra.metadata !== undefined) {
		body.metadata = parseMetadata.call(this, extra.metadata, i);
	}

	return body;
}

/**
 * Metadata, as an object whatever the field handed over.
 *
 * A `json` parameter is a string when it was typed and an object when it
 * came out of an expression, and Jabee refuses a string: a quiet failure
 * here would be a workflow that loses the payment ID it needs back.
 */
function parseMetadata(this: IExecuteFunctions, value: unknown, i: number): IDataObject {
	if (value === null || value === undefined || value === '') return {};
	if (typeof value === 'object') return value as IDataObject;

	let parsed: unknown = null;
	try {
		parsed = JSON.parse(String(value));
	} catch {
		parsed = null;
	}

	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new NodeOperationError(this.getNode(), 'Metadata is not a JSON object', {
			itemIndex: i,
			description:
				'It has to parse to an object, as in {"payment_intent": "pi_123"}. A list or a bare value is refused by the API.',
		});
	}

	return parsed as IDataObject;
}

/**
 * Listing, and paging it with `since`.
 *
 * The API has no cursor: it answers oldest-first and sets `has_more`, and
 * the next page is asked for with the last `updated_at` seen. Two rows
 * that changed in the same millisecond would therefore never advance the
 * cursor, so a page that does not move the time stops the loop rather
 * than asking for ever.
 */
async function listApprovals(this: IExecuteFunctions, i: number): Promise<IDataObject[]> {
	const returnAll = this.getNodeParameter('returnAll', i, false) as boolean;
	const filters = this.getNodeParameter('filters', i, {}) as IDataObject;
	const limit = returnAll ? 100 : (this.getNodeParameter('limit', i, 50) as number);

	let since = filters.since ? String(filters.since) : undefined;
	const rows: IDataObject[] = [];

	for (;;) {
		const page = await jabeeApiRequest.call(this, 'GET', '/approvals', undefined, {
			limit,
			...(filters.status ? { status: filters.status } : {}),
			...(since ? { since } : {}),
		});
		const batch = (page.approvals ?? []) as IDataObject[];
		rows.push(...batch);

		if (!returnAll || page.has_more !== true || batch.length === 0) break;

		const last = batch[batch.length - 1];
		const next = last?.updated_at ? String(last.updated_at) : undefined;
		if (!next || next === since) break;
		since = next;
	}

	return rows;
}
