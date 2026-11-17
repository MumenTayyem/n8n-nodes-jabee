/*
 * `SECRET` below is a made-up string in a test fixture, not a credential:
 * the whole point of these tests is to sign a body and check the result.
 * Disabled per file rather than per line so the intent is stated once.
 */
/* eslint-disable @n8n/community-nodes/no-hardcoded-secrets */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { DEFAULT_TOLERANCE_SECONDS, verifySignature } from '../nodes/Jabee/signature';

/**
 * The only thing standing between a public n8n webhook URL and anybody
 * who finds it. Every case below is a way somebody has got this wrong in
 * a Code node: no secret, no header, a re-serialised body, a signature
 * from last week, a truncated digest.
 */
const SECRET = 'whsec_0123456789abcdef';
const NOW = 1_763_000_000;

function sign(body: string, secret = SECRET, t = NOW): string {
	const digest = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
	return `t=${t},v1=${digest}`;
}

describe('a delivery that really came from Jabee', () => {
	it('accepts the signature Jabee sends', () => {
		const body = JSON.stringify({ id: 'wh_1', event: 'approval.answered' });

		expect(
			verifySignature({ header: sign(body), rawBody: body, secret: SECRET, nowSeconds: NOW }),
		).toEqual({ ok: true });
	});

	it('accepts a raw body handed over as a Buffer', () => {
		// Which is how n8n hands it over: `req.rawBody` is bytes.
		const body = '{"id":"wh_1","event":"message.received"}';

		expect(
			verifySignature({
				header: sign(body),
				rawBody: Buffer.from(body, 'utf8'),
				secret: SECRET,
				nowSeconds: NOW,
			}).ok,
		).toBe(true);
	});

	it('accepts a timestamp inside the tolerance in either direction', () => {
		const body = '{}';
		const late = NOW + DEFAULT_TOLERANCE_SECONDS - 1;
		const early = NOW - DEFAULT_TOLERANCE_SECONDS + 1;

		expect(
			verifySignature({ header: sign(body, SECRET, late), rawBody: body, secret: SECRET, nowSeconds: NOW }).ok,
		).toBe(true);
		expect(
			verifySignature({ header: sign(body, SECRET, early), rawBody: body, secret: SECRET, nowSeconds: NOW }).ok,
		).toBe(true);
	});

	it('signs the bytes, not the parsed object', () => {
		// Re-serialising normalises whitespace and key order, so a check
		// written over `JSON.stringify(req.body)` passes against a body it
		// made up and fails against the bytes that were actually signed.
		const body = '{"event": "approval.answered", "id": "wh_1"}';
		const reserialised = JSON.stringify(JSON.parse(body));

		expect(reserialised).not.toBe(body);
		expect(
			verifySignature({ header: sign(body), rawBody: reserialised, secret: SECRET, nowSeconds: NOW }).ok,
		).toBe(false);
	});
});

describe('a delivery that did not', () => {
	const body = '{"id":"wh_1"}';

	it('refuses a body that changed after it was signed', () => {
		expect(
			verifySignature({
				header: sign(body),
				rawBody: '{"id":"wh_2"}',
				secret: SECRET,
				nowSeconds: NOW,
			}),
		).toEqual({ ok: false, reason: 'the signature does not match the body' });
	});

	it('refuses a signature made with another secret', () => {
		expect(
			verifySignature({
				header: sign(body, 'whsec_someone_else'),
				rawBody: body,
				secret: SECRET,
				nowSeconds: NOW,
			}).ok,
		).toBe(false);
	});

	it('refuses a replay from outside the tolerance', () => {
		const old = NOW - DEFAULT_TOLERANCE_SECONDS - 1;
		const result = verifySignature({
			header: sign(body, SECRET, old),
			rawBody: body,
			secret: SECRET,
			nowSeconds: NOW,
		});

		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toContain('tolerance');
	});

	it('honours a tolerance the node widened', () => {
		const old = NOW - 600;

		expect(
			verifySignature({
				header: sign(body, SECRET, old),
				rawBody: body,
				secret: SECRET,
				nowSeconds: NOW,
				toleranceSeconds: 900,
			}).ok,
		).toBe(true);
	});

	it('refuses a truncated digest rather than throwing', () => {
		// `timingSafeEqual` throws on a length mismatch, which would be a
		// 500 from n8n instead of a refusal.
		const header = `${sign(body).slice(0, -8)}`;

		expect(() =>
			verifySignature({ header, rawBody: body, secret: SECRET, nowSeconds: NOW }),
		).not.toThrow();
		expect(verifySignature({ header, rawBody: body, secret: SECRET, nowSeconds: NOW }).ok).toBe(
			false,
		);
	});

	it('refuses a missing header, a malformed one, and a missing secret, each by name', () => {
		expect(
			verifySignature({ header: undefined, rawBody: body, secret: SECRET, nowSeconds: NOW }),
		).toEqual({ ok: false, reason: 'the X-Jabee-Signature header is missing' });

		expect(
			verifySignature({ header: 'v1=deadbeef', rawBody: body, secret: SECRET, nowSeconds: NOW }),
		).toEqual({ ok: false, reason: 'the X-Jabee-Signature header is not t=<unix>,v1=<hex>' });

		expect(
			verifySignature({ header: `t=${NOW}`, rawBody: body, secret: SECRET, nowSeconds: NOW }).ok,
		).toBe(false);

		expect(verifySignature({ header: sign(body), rawBody: body, secret: '', nowSeconds: NOW })).toEqual(
			{ ok: false, reason: 'no signing secret is set on the Jabee credential' },
		);
	});
});
