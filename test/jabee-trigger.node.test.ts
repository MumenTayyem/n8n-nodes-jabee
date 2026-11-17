/*
 * `SECRET` below is a made-up string in a test fixture, not a credential:
 * the whole point of these tests is to sign a body and check the result.
 * Disabled per file rather than per line so the intent is stated once.
 */
/* eslint-disable @n8n/community-nodes/no-hardcoded-secrets */
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JabeeTrigger } from '../nodes/Jabee/JabeeTrigger.node';
import { fail, fakeHook, fakeWebhook, ok } from './helpers';

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

/**
 * Registering the address, which is the half of this node that talks to
 * Jabee rather than being talked to.
 *
 * One address per Jabee account is the whole shape of these: `create`
 * must not take over somebody else's, `delete` must not take down
 * somebody else's, and the secret Jabee mints on the way through has to
 * be kept, because no route ever reads it back.
 */
const MY_URL = 'https://n8n.example.com/webhook/jabee';
const NEW_SECRET = 'whsec_1111111111111111';

/** What `GET /webhook` answers. */
function address(url: string | null) {
	return ok({ webhook: { set: url !== null, url } });
}

describe('checkExists', () => {
	it('is true when Jabee points here and a secret is held', async () => {
		const { fn, calls } = fakeHook({
			webhookUrl: MY_URL,
			responses: [address(MY_URL)],
			staticData: { webhookSecret: SECRET },
		});

		expect(await node.webhookMethods.default.checkExists.call(fn)).toBe(true);
		expect(calls).toHaveLength(1);
		expect(calls[0]![1]).toMatchObject({ method: 'GET', url: 'https://api.jabee.ai/api/v1/webhook' });
	});

	it('is true when the secret was pasted on the credential instead', async () => {
		const { fn } = fakeHook({
			webhookUrl: MY_URL,
			responses: [address(MY_URL)],
			credentials: { apiKey: 'jak_test', webhookSecret: SECRET },
		});

		expect(await node.webhookMethods.default.checkExists.call(fn)).toBe(true);
	});

	/**
	 * Otherwise activation looks finished and every delivery is refused
	 * 401, which reads as Jabee being broken.
	 */
	it('is false when Jabee points here but no secret is held anywhere', async () => {
		const { fn } = fakeHook({ webhookUrl: MY_URL, responses: [address(MY_URL)] });

		expect(await node.webhookMethods.default.checkExists.call(fn)).toBe(false);
	});

	it('is false when Jabee points somewhere else', async () => {
		const { fn } = fakeHook({
			webhookUrl: MY_URL,
			responses: [address('https://someone-else.example.com/hook')],
			staticData: { webhookSecret: SECRET },
		});

		expect(await node.webhookMethods.default.checkExists.call(fn)).toBe(false);
	});

	it('is false when no address is set at all', async () => {
		const { fn } = fakeHook({ webhookUrl: MY_URL, responses: [address(null)] });

		expect(await node.webhookMethods.default.checkExists.call(fn)).toBe(false);
	});

	it('is false, without a call, when n8n has no URL for this trigger yet', async () => {
		const { fn, calls } = fakeHook({ webhookUrl: undefined, responses: [] });

		expect(await node.webhookMethods.default.checkExists.call(fn)).toBe(false);
		expect(calls).toHaveLength(0);
	});
});

describe('create', () => {
	it('registers this URL and keeps the secret Jabee mints', async () => {
		const { fn, calls, staticData } = fakeHook({
			webhookUrl: MY_URL,
			responses: [
				address(null),
				ok({ webhook: { set: true, url: MY_URL }, secret: NEW_SECRET, change: 'set' }),
			],
		});

		expect(await node.webhookMethods.default.create.call(fn)).toBe(true);
		expect(calls[1]![1]).toMatchObject({
			method: 'PUT',
			url: 'https://api.jabee.ai/api/v1/webhook',
			body: { url: MY_URL },
		});
		expect(staticData.webhookSecret).toBe(NEW_SECRET);
	});

	/**
	 * The reason this node refuses something n8n's lifecycle would do
	 * happily. Taking the address over would stop the deliveries whatever
	 * was there depends on, and a failed activation is the lesser harm.
	 */
	it('refuses to take over an address somebody else set', async () => {
		const { fn, calls, staticData } = fakeHook({
			webhookUrl: MY_URL,
			responses: [address('https://api.someone-else.example.com/very/secret/path')],
		});

		await expect(node.webhookMethods.default.create.call(fn)).rejects.toThrow(
			'Jabee already posts to api.someone-else.example.com',
		);
		expect(calls).toHaveLength(1);
		expect(staticData.webhookSecret).toBeUndefined();
	});

	it('names the host of the address it refused, never the path', async () => {
		const { fn } = fakeHook({
			webhookUrl: MY_URL,
			responses: [address('https://api.someone-else.example.com/very/secret/path')],
		});

		await expect(node.webhookMethods.default.create.call(fn)).rejects.not.toThrow(
			'very/secret/path',
		);
	});

	/**
	 * The same URL with no secret held: `checkExists` said no, and
	 * writing it again is how the secret is obtained.
	 */
	it('re-registers the same URL to get a secret it does not have', async () => {
		const { fn, calls, staticData } = fakeHook({
			webhookUrl: MY_URL,
			responses: [
				address(MY_URL),
				ok({ webhook: { set: true, url: MY_URL }, secret: NEW_SECRET, change: 'replaced' }),
			],
		});

		expect(await node.webhookMethods.default.create.call(fn)).toBe(true);
		expect(calls).toHaveLength(2);
		expect(staticData.webhookSecret).toBe(NEW_SECRET);
	});

	it("reads Jabee's refusal out loud when the address is rejected", async () => {
		const { fn } = fakeHook({
			webhookUrl: 'http://n8n.example.com/webhook/jabee',
			responses: [
				address(null),
				fail(400, {
					error: 'invalid_url',
					field: 'url',
					detail: 'That address cannot be used: protocol http: is not allowed, use https.',
				}),
			],
		});

		await expect(node.webhookMethods.default.create.call(fn)).rejects.toThrow(
			'invalid_url: That address cannot be used',
		);
	});

	it('says what to do when n8n has no URL for this trigger', async () => {
		const { fn, calls } = fakeHook({ webhookUrl: undefined, responses: [] });

		await expect(node.webhookMethods.default.create.call(fn)).rejects.toThrow(
			'This trigger has no webhook URL yet',
		);
		expect(calls).toHaveLength(0);
	});
});

describe('delete', () => {
	it("removes the address when it is this workflow's", async () => {
		const { fn, calls, staticData } = fakeHook({
			webhookUrl: MY_URL,
			responses: [address(MY_URL), ok({ webhook: { set: false, url: null }, change: 'removed' })],
			staticData: { webhookSecret: SECRET },
		});

		expect(await node.webhookMethods.default.delete.call(fn)).toBe(true);
		expect(calls[1]![1]).toMatchObject({
			method: 'DELETE',
			url: 'https://api.jabee.ai/api/v1/webhook',
		});
		expect(staticData.webhookSecret).toBeUndefined();
	});

	it("leaves somebody else's address alone, and says so in the log", async () => {
		const { fn, calls, staticData, warnings } = fakeHook({
			webhookUrl: MY_URL,
			responses: [address('https://someone-else.example.com/hook')],
			staticData: { webhookSecret: SECRET },
		});

		expect(await node.webhookMethods.default.delete.call(fn)).toBe(true);
		expect(calls).toHaveLength(1);
		expect(warnings[0]).toContain('someone-else.example.com');
		expect(staticData.webhookSecret).toBeUndefined();
	});

	it('is content when there is no address to remove', async () => {
		const { fn, calls } = fakeHook({ webhookUrl: MY_URL, responses: [address(null)] });

		expect(await node.webhookMethods.default.delete.call(fn)).toBe(true);
		expect(calls).toHaveLength(1);
	});
});

describe('which secret a delivery is checked against', () => {
	it('uses the one create was handed, with nothing on the credential', async () => {
		const { raw, header } = delivery(answered, NEW_SECRET);
		const { fn, response } = fakeWebhook({
			params: { events: ['approval.answered'], options: {} },
			body: answered,
			rawBody: raw,
			headers: { 'x-jabee-signature': header },
			credentials: { webhookSecret: '' },
			staticData: { webhookSecret: NEW_SECRET },
		});

		const result = await node.webhook.call(fn);

		expect(response.status).toBeNull();
		expect(result.workflowData).toBeDefined();
	});

	/**
	 * Both can be legitimate: one came from registering, the other was
	 * pasted after setting the address on the dashboard. Which is live is
	 * not knowable from inside the trigger.
	 */
	it('falls back to the credential when the registered one is stale', async () => {
		const { raw, header } = delivery(answered, SECRET);
		const { fn, response } = fakeWebhook({
			params: { events: ['approval.answered'], options: {} },
			body: answered,
			rawBody: raw,
			headers: { 'x-jabee-signature': header },
			credentials: { webhookSecret: SECRET },
			staticData: { webhookSecret: 'whsec_nolongerthelivesecret' },
		});

		const result = await node.webhook.call(fn);

		expect(response.status).toBeNull();
		expect(result.workflowData).toBeDefined();
	});

	it('still refuses a delivery that matches neither', async () => {
		const { raw, header } = delivery(answered, 'whsec_somebodyelsesentthis');
		const { fn, response } = fakeWebhook({
			params: { events: ['approval.answered'], options: {} },
			body: answered,
			rawBody: raw,
			headers: { 'x-jabee-signature': header },
			credentials: { webhookSecret: SECRET },
			staticData: { webhookSecret: NEW_SECRET },
		});

		await node.webhook.call(fn);

		expect(response.status).toBe(401);
	});
});
