/*
 * `SECRET` below is a made-up string in a test fixture, not a credential:
 * the whole point of these tests is to sign a body and check the result.
 * Disabled per file rather than per line so the intent is stated once.
 */
/* eslint-disable @n8n/community-nodes/no-hardcoded-secrets */
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JabeeTrigger } from '../nodes/Jabee/JabeeTrigger.node';
import { fakeWebhook } from './helpers';

/**
 * The trigger, which is a public URL on somebody's n8n. Everything here
 * is about what happens to a request that should not start a workflow:
 * an unsigned one, a replayed one, an event this workflow did not ask
 * for, and the misconfiguration of having no secret at all.
 */
const SECRET = 'whsec_0123456789abcdef';
const NOW = 1_763_000_000_000;

const node = new JabeeTrigger();

function delivery(payload: Record<string, unknown>, secret = SECRET) {
	const raw = JSON.stringify(payload);
	const t = Math.floor(NOW / 1000);
	const digest = createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
	return { raw, header: `t=${t},v1=${digest}` };
}

const answered = {
	id: 'wh_1',
	event: 'approval.answered',
	approval: {
		id: 'ap_1',
		kind: 'approval',
		status: 'approved',
		metadata: { payment_intent: 'pi_123' },
	},
};

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
});

afterEach(() => {
	vi.useRealTimers();
});

describe('a delivery this workflow asked for', () => {
	it('starts the workflow with the body exactly as Jabee sent it', async () => {
		const { raw, header } = delivery(answered);
		const { fn } = fakeWebhook({
			params: { events: ['approval.answered'], options: {} },
			body: answered,
			rawBody: raw,
			headers: { 'x-jabee-signature': header, 'x-jabee-event': 'approval.answered' },
			credentials: { webhookSecret: SECRET },
		});

		const result = await node.webhook.call(fn);

		// No reshaping on purpose: `id` is the delivery ID to dedupe on,
		// and `metadata` is what the workflow put there in the first place.
		expect(result.workflowData?.[0]?.[0]?.json).toEqual(answered);
	});

	it('relays what a handset typed back, which has no counterpart elsewhere', async () => {
		const inbound = {
			id: 'wh_2',
			event: 'message.received',
			message: {
				text: 'redeploy',
				from: '971561652138',
				received_at: '2026-11-17T10:00:00.000Z',
				about_approval_id: null,
				whatsapp_message_id: 'wamid.x',
			},
		};
		const { raw, header } = delivery(inbound);
		const { fn } = fakeWebhook({
			params: { events: ['message.received'], options: {} },
			body: inbound,
			rawBody: raw,
			headers: { 'x-jabee-signature': header },
			credentials: { webhookSecret: SECRET },
		});

		const result = await node.webhook.call(fn);

		expect(result.workflowData?.[0]?.[0]?.json).toMatchObject({ event: 'message.received' });
	});

	it('adds the headers only when asked', async () => {
		const { raw, header } = delivery(answered);
		const base = {
			params: { events: ['approval.answered'], options: { includeHeaders: true } },
			body: answered,
			rawBody: raw,
			headers: { 'x-jabee-signature': header, 'x-jabee-delivery': 'wh_1' },
			credentials: { webhookSecret: SECRET },
		};

		const withHeaders = await node.webhook.call(fakeWebhook(base).fn);
		expect(withHeaders.workflowData?.[0]?.[0]?.json.headers).toMatchObject({
			'x-jabee-delivery': 'wh_1',
		});

		const without = await node.webhook.call(
			fakeWebhook({ ...base, params: { events: ['approval.answered'], options: {} } }).fn,
		);
		expect(without.workflowData?.[0]?.[0]?.json).not.toHaveProperty('headers');
	});
});

describe('a delivery it did not', () => {
	it('answers an event it is not subscribed to with a 2xx, not a refusal', async () => {
		// Every account event goes to one address. Refusing the expiries
		// would teach Jabee to retry them for eleven hours.
		const expired = { id: 'wh_3', event: 'approval.expired', approval: { id: 'ap_1' } };
		const { raw, header } = delivery(expired);
		const { fn, response } = fakeWebhook({
			params: { events: ['approval.answered'], options: {} },
			body: expired,
			rawBody: raw,
			headers: { 'x-jabee-signature': header },
			credentials: { webhookSecret: SECRET },
		});

		const result = await node.webhook.call(fn);

		expect(result.workflowData).toBeUndefined();
		expect(result.webhookResponse).toBe('ignored');
		expect(response.status).toBeNull();
	});

	it('refuses an unsigned request with a 401 and starts nothing', async () => {
		const { fn, response, warnings } = fakeWebhook({
			params: { events: ['approval.answered'], options: {} },
			body: answered,
			headers: {},
			credentials: { webhookSecret: SECRET },
		});

		const result = await node.webhook.call(fn);

		expect(response.status).toBe(401);
		expect(result).toEqual({ noWebhookResponse: true });
		// The reason goes to the log, not into the response body.
		expect(warnings[0]).toContain('X-Jabee-Signature header is missing');
		expect(response.sent).toBe('Unauthorized');
	});

	it('refuses a body that was altered in flight', async () => {
		const { header } = delivery(answered);
		const tampered = { ...answered, approval: { ...answered.approval, status: 'approved_lol' } };
		const { fn, response } = fakeWebhook({
			params: { events: ['approval.answered'], options: {} },
			body: tampered,
			rawBody: JSON.stringify(tampered),
			headers: { 'x-jabee-signature': header },
			credentials: { webhookSecret: SECRET },
		});

		await node.webhook.call(fn);

		expect(response.status).toBe(401);
	});

	it('refuses a replay from outside the tolerance, and accepts it when widened', async () => {
		const { raw, header } = delivery(answered);
		const stale = () => {
			vi.setSystemTime(NOW + 400_000);
			return {
				params: { events: ['approval.answered'], options: {} },
				body: answered,
				rawBody: raw,
				headers: { 'x-jabee-signature': header },
				credentials: { webhookSecret: SECRET },
			};
		};

		const refused = fakeWebhook(stale());
		await node.webhook.call(refused.fn);
		expect(refused.response.status).toBe(401);

		const widened = fakeWebhook({
			...stale(),
			params: { events: ['approval.answered'], options: { tolerance: 900 } },
		});
		const result = await node.webhook.call(widened.fn);
		expect(widened.response.status).toBeNull();
		expect(result.workflowData).toBeDefined();
	});

	it('takes the first value when a header arrives repeated', async () => {
		const { raw, header } = delivery(answered);
		const { fn, response } = fakeWebhook({
			params: { events: ['approval.answered'], options: {} },
			body: answered,
			rawBody: raw,
			headers: { 'x-jabee-signature': [header, 't=1,v1=00'] },
			credentials: { webhookSecret: SECRET },
		});

		await node.webhook.call(fn);

		expect(response.status).toBeNull();
	});
});

describe('a credential with no signing secret', () => {
	it('says what to fix rather than refusing every delivery', async () => {
		const { raw, header } = delivery(answered);
		const { fn } = fakeWebhook({
			params: { events: ['approval.answered'], options: {} },
			body: answered,
			rawBody: raw,
			headers: { 'x-jabee-signature': header },
			credentials: { webhookSecret: '' },
		});

		await expect(node.webhook.call(fn)).rejects.toThrow(
			'Add the webhook signing secret to the Jabee credential',
		);
	});
});
