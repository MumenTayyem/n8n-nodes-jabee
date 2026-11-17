import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeApiError } from 'n8n-workflow';

import {
	jabeeApiRequest,
	retryAfterMs,
	timing,
	waitForAnswer,
} from '../nodes/Jabee/GenericFunctions';
import { fail, fakeExecute, ok } from './helpers';

/**
 * The layer every operation goes through: the key, the base URL, the two
 * different 429s, and turning a refusal into something a person can act
 * on.
 */
const realSleep = timing.sleep;
const realNow = timing.now;
let slept: number[] = [];

beforeEach(() => {
	slept = [];
	timing.sleep = async (ms: number) => void slept.push(ms);
});

afterEach(() => {
	timing.sleep = realSleep;
	timing.now = realNow;
});

describe('making a call', () => {
	it('sends the credential type, the base URL and the path', async () => {
		const { fn, calls } = fakeExecute({
			params: {},
			responses: [ok({ id: 'ap_1', status: 'pending' }, 201)],
		});

		const body = await jabeeApiRequest.call(fn, 'POST', '/approvals', { title: 'Refund' });

		expect(body).toEqual({ id: 'ap_1', status: 'pending' });
		const [credentialType, request] = calls[0]!;
		expect(credentialType).toBe('jabeeApi');
		expect(request.url).toBe('https://api.jabee.ai/api/v1/approvals');
		expect(request.method).toBe('POST');
		expect(request.body).toEqual({ title: 'Refund' });
		// Both on, or the refusal body below is never readable.
		expect(request.returnFullResponse).toBe(true);
		expect(request.ignoreHttpStatusErrors).toBe(true);
	});

	it('honours a base URL from the credential, trailing slashes and all', async () => {
		const { fn, calls } = fakeExecute({
			params: {},
			credentials: { apiKey: 'jak_test', baseUrl: 'http://localhost:4000/api/v1///' },
			responses: [ok({ approvals: [], has_more: false })],
		});

		await jabeeApiRequest.call(fn, 'GET', '/approvals');

		expect(calls[0]![1].url).toBe('http://localhost:4000/api/v1/approvals');
	});
});

describe('refusals', () => {
	it('carries the API’s own code and sentence into the error', async () => {
		const { fn } = fakeExecute({
			params: {},
			responses: [
				fail(402, {
					error: 'allowance_used_up',
					detail: '500 approvals and alerts are included each month.',
				}),
			],
		});

		await expect(jabeeApiRequest.call(fn, 'POST', '/alerts', { title: 'x' })).rejects.toThrow(
			'allowance_used_up: 500 approvals and alerts are included each month.',
		);
	});

	it('names the field on a 400, because that is the one the workflow typed', async () => {
		const { fn } = fakeExecute({
			params: {},
			responses: [
				fail(400, {
					error: 'invalid_request',
					field: 'title',
					detail: 'title is at most 120 characters',
				}),
			],
		});

		await expect(jabeeApiRequest.call(fn, 'POST', '/alerts', { title: 'x' })).rejects.toMatchObject({
			description: "The field at fault is 'title'.",
		});
	});

	it('says what to do about a key that was revoked', async () => {
		// A 401 arrives with no `detail` at all when the key is malformed,
		// so the node supplies the sentence rather than printing "401".
		const { fn } = fakeExecute({ params: {}, responses: [fail(401, { error: 'unauthorised' })] });

		const error = await jabeeApiRequest.call(fn, 'GET', '/approvals').catch((e: unknown) => e);

		expect(error).toBeInstanceOf(NodeApiError);
		expect((error as Error).message).toContain('unauthorised:');
		expect((error as Error).message).toContain('Management then Approvals');
	});

	it('does not pretend an empty body is a success', async () => {
		const { fn } = fakeExecute({ params: {}, responses: [{ statusCode: 500 }] });

		await expect(jabeeApiRequest.call(fn, 'GET', '/approvals')).rejects.toThrow('http_500');
	});
});

describe('the two rate limits', () => {
	it('waits out the per-minute limit and retries', async () => {
		const { fn, calls } = fakeExecute({
			params: {},
			responses: [
				fail(429, { error: 'rate_limited' }, { 'retry-after': '3' }),
				ok({ id: 'ap_1' }, 201),
			],
		});

		await jabeeApiRequest.call(fn, 'POST', '/approvals', { title: 'x' });

		expect(slept).toEqual([3_000]);
		expect(calls).toHaveLength(2);
	});

	it('gives up after two waits rather than looping', async () => {
		const { fn, calls } = fakeExecute({
			params: {},
			responses: [
				fail(429, { error: 'rate_limited' }),
				fail(429, { error: 'rate_limited' }),
				fail(429, { error: 'rate_limited', detail: 'At most 60 requests a minute per key.' }),
			],
		});

		await expect(jabeeApiRequest.call(fn, 'GET', '/approvals')).rejects.toThrow('rate_limited');
		expect(calls).toHaveLength(3);
		expect(slept).toEqual([2_000, 2_000]);
	});

	it('never retries the daily limit, which cannot be waited out', async () => {
		// 200 new requests per business per 24 hours. Sleeping on that
		// would hold an execution open for hours and still fail.
		const { fn, calls } = fakeExecute({
			params: {},
			responses: [
				fail(429, {
					error: 'daily_limit_reached',
					detail: 'An account can send 200 requests in 24 hours.',
				}),
			],
		});

		await expect(jabeeApiRequest.call(fn, 'POST', '/alerts', { title: 'x' })).rejects.toThrow(
			'daily_limit_reached',
		);
		expect(calls).toHaveLength(1);
		expect(slept).toEqual([]);
	});

	/**
	 * Jabee answers 429 for four things and only the per-minute one is
	 * worth a pause. The webhook limit is ten changes an hour and the
	 * heartbeat one is a count of checks: sleeping on either would hold an
	 * execution open and still fail.
	 */
	it.each([['webhook_limit_reached'], ['heartbeat_limit_reached']])(
		'never retries %s, which an execution cannot wait out',
		async (error) => {
			const { fn, calls } = fakeExecute({
				params: {},
				responses: [fail(429, { error, detail: 'A sentence naming the fix.' }, { 'retry-after': '900' })],
			});

			await expect(jabeeApiRequest.call(fn, 'PUT', '/webhook', { url: 'https://x.test/h' })).rejects.toThrow(
				error,
			);
			expect(calls).toHaveLength(1);
			expect(slept).toEqual([]);
		},
	);

	it('clamps a Retry-After it cannot trust', () => {
		expect(retryAfterMs('5')).toBe(5_000);
		expect(retryAfterMs(undefined)).toBe(2_000);
		expect(retryAfterMs('nonsense')).toBe(2_000);
		expect(retryAfterMs('0')).toBe(1_000);
		expect(retryAfterMs('86400')).toBe(30_000);
		expect(retryAfterMs(['7', '9'])).toBe(7_000);
	});
});

describe('waiting for an answer', () => {
	it('stops the moment the status moves off pending', async () => {
		const reads = [{ status: 'pending' }, { status: 'pending' }, { status: 'approved' }];
		const read = vi.fn(async () => reads.shift()!);
		timing.now = () => 0;

		const answer = await waitForAnswer(read, 600_000);

		expect(answer).toEqual({ status: 'approved' });
		expect(read).toHaveBeenCalledTimes(3);
		// Short first, then backing off, so an answer that arrives in
		// three seconds is not waited on for thirty.
		expect(slept).toEqual([2_000, 3_200]);
	});

	it('treats an expiry as an ending, not as something to keep polling', async () => {
		const read = vi.fn(async () => ({ status: 'expired' }));
		timing.now = () => 0;

		await expect(waitForAnswer(read, 600_000)).resolves.toEqual({ status: 'expired' });
		expect(read).toHaveBeenCalledTimes(1);
		expect(slept).toEqual([]);
	});

	it('hands back the pending request when the timeout is reached', async () => {
		// Not an error: the request is still live on somebody's phone, and
		// the workflow is given its ID to read later.
		let clock = 0;
		timing.now = () => clock;
		timing.sleep = async (ms: number) => {
			slept.push(ms);
			clock += ms;
		};
		const read = vi.fn(async () => ({ id: 'ap_1', status: 'pending' }));

		const answer = await waitForAnswer(read, 10_000);

		expect(answer).toEqual({ id: 'ap_1', status: 'pending' });
		expect(slept).toEqual([2_000, 3_200]);
		expect(read).toHaveBeenCalledTimes(3);
	});

	it('reads once and stops when there is no time to wait at all', async () => {
		timing.now = () => 0;
		const read = vi.fn(async () => ({ status: 'pending' }));

		await waitForAnswer(read, 0);

		expect(read).toHaveBeenCalledTimes(1);
		expect(slept).toEqual([]);
	});
});
