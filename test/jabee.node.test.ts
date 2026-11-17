import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Jabee } from '../nodes/Jabee/Jabee.node';
import { timing } from '../nodes/Jabee/GenericFunctions';
import { fail, fakeExecute, ok } from './helpers';

/**
 * The node itself: what each operation sends, and what the workflow gets
 * back.
 *
 * The cases that earn their keep here are the ones a reader of the API
 * docs would get wrong. An alert must not carry `options`, because the
 * alert schema refuses it. A repeated External ID comes back 200 with
 * `existing: true` and must not then be waited on, because nothing is
 * going to change. And a revision with nothing to change is caught before
 * the call, because the API's 400 says less than the node can.
 */
const realSleep = timing.sleep;
const realNow = timing.now;

beforeEach(() => {
	timing.sleep = async () => {};
	timing.now = () => 0;
});

afterEach(() => {
	timing.sleep = realSleep;
	timing.now = realNow;
});

const node = new Jabee();

const approval = (over: Record<string, unknown> = {}) => ({
	id: '11111111-2222-3333-4444-555555555555',
	kind: 'approval',
	status: 'pending',
	round: 0,
	title: 'Refund 450 AED to Sara',
	body: '',
	url: null,
	options: ['approve', 'skip'],
	external_id: null,
	metadata: {},
	response_text: null,
	expires_at: '2026-11-18T10:00:00.000Z',
	created_at: '2026-11-17T10:00:00.000Z',
	updated_at: '2026-11-17T10:00:00.000Z',
	...over,
});

describe('sending an alert', () => {
	it('posts to /alerts with no buttons, which the alert schema refuses', async () => {
		const { fn, calls } = fakeExecute({
			params: {
				resource: 'alert',
				operation: 'send',
				title: 'Nightly sync failed',
				body: '14 rows were rejected',
				additionalFields: { external_id: 'sync-2026-11-17', url: 'https://logs.example/42' },
			},
			responses: [ok({ ...approval({ kind: 'alert' }), options: undefined }, 201)],
		});

		const [rows] = await node.execute.call(fn);

		const [, request] = calls[0]!;
		expect(request.url).toBe('https://api.jabee.ai/api/v1/alerts');
		expect(request.body).toEqual({
			title: 'Nightly sync failed',
			body: '14 rows were rejected',
			external_id: 'sync-2026-11-17',
			url: 'https://logs.example/42',
		});
		expect(request.body).not.toHaveProperty('options');
		expect(rows?.[0]?.pairedItem).toEqual({ item: 0 });
	});

	it('sends one call per input item, which is how a list becomes a bill', async () => {
		const { fn, calls } = fakeExecute({
			params: { resource: 'alert', operation: 'send', title: 'Row failed', additionalFields: {} },
			items: [{ id: 1 }, { id: 2 }, { id: 3 }],
			responses: [ok(approval(), 201), ok(approval(), 201), ok(approval(), 201)],
		});

		const [rows] = await node.execute.call(fn);

		expect(calls).toHaveLength(3);
		expect(rows).toHaveLength(3);
	});
});

describe('requesting an approval', () => {
	it('sends the buttons, the metadata and the expiry', async () => {
		const { fn, calls } = fakeExecute({
			params: {
				resource: 'approval',
				operation: 'request',
				title: 'Refund 450 AED to Sara',
				body: 'Card charged twice on 14 November.',
				options: ['approve', 'edit'],
				wait: false,
				additionalFields: {
					external_id: 'refund-1043',
					expires_in_minutes: 60,
					metadata: '{"payment_intent":"pi_123"}',
				},
			},
			responses: [ok(approval({ existing: false }), 201)],
		});

		await node.execute.call(fn);

		expect(calls[0]![1].body).toEqual({
			title: 'Refund 450 AED to Sara',
			body: 'Card charged twice on 14 November.',
			options: ['approve', 'edit'],
			external_id: 'refund-1043',
			expires_in_minutes: 60,
			metadata: { payment_intent: 'pi_123' },
		});
	});

	it('takes metadata that arrived from an expression as an object already', async () => {
		const { fn, calls } = fakeExecute({
			params: {
				resource: 'approval',
				operation: 'request',
				title: 'x',
				options: ['approve'],
				wait: false,
				additionalFields: { metadata: { execution: '9001' } },
			},
			responses: [ok(approval(), 201)],
		});

		await node.execute.call(fn);

		expect((calls[0]![1].body as Record<string, unknown>).metadata).toEqual({ execution: '9001' });
	});

	it('refuses metadata that is not an object, before spending a message on it', async () => {
		const { fn, calls } = fakeExecute({
			params: {
				resource: 'approval',
				operation: 'request',
				title: 'x',
				options: ['approve'],
				wait: false,
				additionalFields: { metadata: '["a","b"]' },
			},
			responses: [],
		});

		await expect(node.execute.call(fn)).rejects.toThrow('Metadata is not a JSON object');
		expect(calls).toHaveLength(0);
	});

	it('waits for a tap and returns the answer', async () => {
		const { fn, calls } = fakeExecute({
			params: {
				resource: 'approval',
				operation: 'request',
				title: 'Refund 450 AED to Sara',
				options: ['approve', 'skip'],
				wait: true,
				waitTimeout: 900,
				additionalFields: {},
			},
			responses: [
				ok(approval({ existing: false }), 201),
				ok(approval({ status: 'pending' })),
				ok(
					approval({
						status: 'approved',
						response_text: null,
						responded_by: { type: 'owner', id: 'u1', name: 'Mumen' },
					}),
				),
			],
		});

		const [rows] = await node.execute.call(fn);

		expect(rows?.[0]?.json.status).toBe('approved');
		// The create, then two reads of the same request.
		expect(calls).toHaveLength(3);
		expect(calls[1]![1].url).toBe(
			'https://api.jabee.ai/api/v1/approvals/11111111-2222-3333-4444-555555555555',
		);
		expect(calls[1]![1].method).toBe('GET');
	});

	it('carries `existing` across the wait, so a rerun can still tell', async () => {
		const { fn } = fakeExecute({
			params: {
				resource: 'approval',
				operation: 'request',
				title: 'x',
				options: ['approve'],
				wait: true,
				waitTimeout: 900,
				additionalFields: { external_id: 'refund-1043' },
			},
			responses: [
				ok(approval({ existing: false }), 201),
				ok(approval({ status: 'skipped' })),
			],
		});

		const [rows] = await node.execute.call(fn);

		expect(rows?.[0]?.json).toMatchObject({ status: 'skipped', existing: false });
	});

	it('does not wait on a duplicate External ID, which is already settled', async () => {
		// The second run of the same workflow. Jabee answers 200 with the
		// request it already made, and polling it would read the same row
		// until the timeout for nothing.
		const { fn, calls } = fakeExecute({
			params: {
				resource: 'approval',
				operation: 'request',
				title: 'Refund 450 AED to Sara',
				options: ['approve', 'skip'],
				wait: true,
				waitTimeout: 900,
				additionalFields: { external_id: 'refund-1043' },
			},
			responses: [ok(approval({ status: 'approved', existing: true, external_id: 'refund-1043' }))],
		});

		const [rows] = await node.execute.call(fn);

		expect(calls).toHaveLength(1);
		expect(rows?.[0]?.json).toMatchObject({ existing: true, status: 'approved' });
	});

	it('does not wait on a request that reached nobody', async () => {
		// Delivery happens before the response returns, so `failed` is
		// already final when the create comes back.
		const { fn, calls } = fakeExecute({
			params: {
				resource: 'approval',
				operation: 'request',
				title: 'x',
				options: ['approve'],
				wait: true,
				waitTimeout: 900,
				additionalFields: {},
			},
			responses: [ok(approval({ status: 'failed', existing: false }), 201)],
		});

		const [rows] = await node.execute.call(fn);

		expect(calls).toHaveLength(1);
		expect(rows?.[0]?.json.status).toBe('failed');
	});

	it('hands back a pending request when the timeout runs out', async () => {
		let clock = 0;
		timing.now = () => clock;
		timing.sleep = async (ms: number) => void (clock += ms);

		const { fn } = fakeExecute({
			params: {
				resource: 'approval',
				operation: 'request',
				title: 'x',
				options: ['approve'],
				wait: true,
				waitTimeout: 10,
				additionalFields: {},
			},
			responses: [
				ok(approval({ existing: false }), 201),
				ok(approval()),
				ok(approval()),
				ok(approval()),
			],
		});

		const [rows] = await node.execute.call(fn);

		expect(rows?.[0]?.json.status).toBe('pending');
		expect(rows?.[0]?.json.id).toBe('11111111-2222-3333-4444-555555555555');
	});
});

describe('reading an approval back', () => {
	it('gets one by ID', async () => {
		const { fn, calls } = fakeExecute({
			params: { resource: 'approval', operation: 'get', approvalId: 'ap_1' },
			responses: [ok(approval({ status: 'approved' }))],
		});

		const [rows] = await node.execute.call(fn);

		expect(calls[0]![1].url).toBe('https://api.jabee.ai/api/v1/approvals/ap_1');
		expect(rows?.[0]?.json.status).toBe('approved');
	});

	it('lists with the filters the API accepts', async () => {
		const { fn, calls } = fakeExecute({
			params: {
				resource: 'approval',
				operation: 'getAll',
				returnAll: false,
				limit: 25,
				filters: { status: 'pending', since: '2026-11-17T09:00:00.000Z' },
			},
			responses: [ok({ approvals: [approval(), approval()], has_more: true })],
		});

		const [rows] = await node.execute.call(fn);

		expect(calls[0]![1].qs).toEqual({
			limit: 25,
			status: 'pending',
			since: '2026-11-17T09:00:00.000Z',
		});
		// `has_more` is ignored when a limit was asked for.
		expect(rows).toHaveLength(2);
		expect(calls).toHaveLength(1);
	});

	it('pages Return All on the last `updated_at` it saw', async () => {
		const { fn, calls } = fakeExecute({
			params: { resource: 'approval', operation: 'getAll', returnAll: true, filters: {} },
			responses: [
				ok({
					approvals: [approval({ updated_at: '2026-11-17T10:00:00.000Z' })],
					has_more: true,
				}),
				ok({
					approvals: [approval({ updated_at: '2026-11-17T11:00:00.000Z' })],
					has_more: false,
				}),
			],
		});

		const [rows] = await node.execute.call(fn);

		expect(rows).toHaveLength(2);
		expect(calls[0]![1].qs).toEqual({ limit: 100 });
		expect(calls[1]![1].qs).toEqual({ limit: 100, since: '2026-11-17T10:00:00.000Z' });
	});

	it('stops paging when the cursor cannot move, rather than asking for ever', async () => {
		// Two rows that changed in the same millisecond would hand back
		// the same `since` for ever. The API has no cursor, so the guard
		// is here.
		const { fn, calls } = fakeExecute({
			params: {
				resource: 'approval',
				operation: 'getAll',
				returnAll: true,
				filters: { since: '2026-11-17T10:00:00.000Z' },
			},
			responses: [
				ok({
					approvals: [approval({ updated_at: '2026-11-17T10:00:00.000Z' })],
					has_more: true,
				}),
			],
		});

		const [rows] = await node.execute.call(fn);

		expect(calls).toHaveLength(1);
		expect(rows).toHaveLength(1);
	});
});

describe('revise, cancel and outcome', () => {
	it('refuses a revision with nothing a person would see changed', async () => {
		const { fn, calls } = fakeExecute({
			params: {
				resource: 'approval',
				operation: 'revise',
				approvalId: 'ap_1',
				reviseFields: { expires_in_minutes: 60 },
			},
			responses: [],
		});

		await expect(node.execute.call(fn)).rejects.toThrow('Give a Title, a Body or a Link to change');
		expect(calls).toHaveLength(0);
	});

	it('puts the amended request again', async () => {
		const { fn, calls } = fakeExecute({
			params: {
				resource: 'approval',
				operation: 'revise',
				approvalId: 'ap_1',
				reviseFields: { title: 'Refund 400 AED to Sara' },
			},
			responses: [ok(approval({ round: 1, status: 'pending' }))],
		});

		const [rows] = await node.execute.call(fn);

		expect(calls[0]![1].url).toBe('https://api.jabee.ai/api/v1/approvals/ap_1/revise');
		expect(calls[0]![1].body).toEqual({ title: 'Refund 400 AED to Sara' });
		expect(rows?.[0]?.json.round).toBe(1);
	});

	it('reports a round cap as the API worded it', async () => {
		const { fn } = fakeExecute({
			params: {
				resource: 'approval',
				operation: 'revise',
				approvalId: 'ap_1',
				reviseFields: { title: 'again' },
			},
			responses: [
				fail(409, {
					error: 'too_many_rounds',
					detail: 'A request can be revised 5 times. Create a new one.',
					rounds: 5,
				}),
			],
		});

		await expect(node.execute.call(fn)).rejects.toThrow(
			'too_many_rounds: A request can be revised 5 times. Create a new one.',
		);
	});

	it('cancels, with and without a reason', async () => {
		const { fn, calls } = fakeExecute({
			params: { resource: 'approval', operation: 'cancel', approvalId: 'ap_1', reason: '' },
			items: [{}, {}],
			responses: [ok(approval({ status: 'cancelled' })), ok(approval({ status: 'cancelled' }))],
		});
		await node.execute.call(fn);
		expect(calls[0]![1].body).toEqual({});

		const withReason = fakeExecute({
			params: {
				resource: 'approval',
				operation: 'cancel',
				approvalId: 'ap_1',
				reason: 'The customer withdrew it',
			},
			responses: [ok(approval({ status: 'cancelled' }))],
		});
		await node.execute.call(withReason.fn);
		expect(withReason.calls[0]![1].body).toEqual({ reason: 'The customer withdrew it' });
	});

	it('reports what the workflow actually did', async () => {
		const { fn, calls } = fakeExecute({
			params: {
				resource: 'approval',
				operation: 'reportOutcome',
				approvalId: 'ap_1',
				outcome: 'refunded',
				note: 'Stripe refund re_123',
			},
			responses: [ok(approval({ status: 'approved', outcome: 'refunded' }))],
		});

		await node.execute.call(fn);

		expect(calls[0]![1].url).toBe('https://api.jabee.ai/api/v1/approvals/ap_1/outcome');
		expect(calls[0]![1].body).toEqual({ outcome: 'refunded', note: 'Stripe refund re_123' });
	});
});

describe('checking in to a heartbeat', () => {
	it('puts the schedule on the query string, where a URL can carry it', async () => {
		const { fn, calls } = fakeExecute({
			params: {
				resource: 'heartbeat',
				operation: 'checkIn',
				heartbeatName: 'nightly-sync',
				every: '1d',
				grace: '30m',
				recover: true,
			},
			responses: [ok({ name: 'nightly-sync', state: 'up', created: true }, 201)],
		});

		const [rows] = await node.execute.call(fn);

		expect(calls[0]![1].url).toBe('https://api.jabee.ai/api/v1/heartbeat/nightly-sync');
		expect(calls[0]![1].qs).toEqual({ every: '1d', grace: '30m', recover: 'true' });
		expect(rows?.[0]?.json.state).toBe('up');
	});

	it('leaves the schedule out when nothing was set, so a second check-in cannot re-time it', async () => {
		const { fn, calls } = fakeExecute({
			params: {
				resource: 'heartbeat',
				operation: 'checkIn',
				heartbeatName: 'nightly-sync',
				every: '',
				grace: '',
				recover: false,
			},
			responses: [ok({ name: 'nightly-sync', state: 'up', created: false })],
		});

		await node.execute.call(fn);

		expect(calls[0]![1].qs).toEqual({});
	});
});

describe('failures', () => {
	it('stops the execution by default', async () => {
		const { fn } = fakeExecute({
			params: { resource: 'approval', operation: 'get', approvalId: 'nope' },
			responses: [fail(404, { error: 'not_found' })],
		});

		await expect(node.execute.call(fn)).rejects.toThrow('not_found:');
	});

	it('puts the failure on the item when the node is set to continue', async () => {
		const { fn } = fakeExecute({
			params: { resource: 'approval', operation: 'get', approvalId: 'nope' },
			items: [{ row: 1 }, { row: 2 }],
			responses: [fail(404, { error: 'not_found' }), ok(approval({ status: 'approved' }))],
			continueOnFail: true,
		});

		const [rows] = await node.execute.call(fn);

		expect(rows).toHaveLength(2);
		expect(String(rows?.[0]?.json.error)).toContain('not_found');
		expect(rows?.[0]?.pairedItem).toEqual({ item: 0 });
		expect(rows?.[1]?.json.status).toBe('approved');
	});

	it('names an operation it does not have rather than calling a made-up path', async () => {
		const { fn, calls } = fakeExecute({
			params: { resource: 'alert', operation: 'revise' },
			responses: [],
		});

		await expect(node.execute.call(fn)).rejects.toThrow(
			"The operation 'revise' is not supported on 'alert'",
		);
		expect(calls).toHaveLength(0);
	});
});
