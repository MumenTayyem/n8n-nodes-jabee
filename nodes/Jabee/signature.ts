import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Checking that a delivery really came from Jabee.
 *
 * The header is `X-Jabee-Signature: t=<unix seconds>,v1=<hex>`, and the
 * digest is HMAC-SHA256 of `<t>.<raw body>` under the account's `whsec_`
 * secret. Signed the way Stripe signs, and for the same reason: the
 * timestamp is inside the digest, so a delivery captured today cannot be
 * replayed next week.
 *
 * Three things this gets right that a hand-rolled check in a Code node
 * usually does not. It verifies the *raw* bytes, because re-serialising
 * parsed JSON reorders keys and changes the digest. It compares in
 * constant time, because a byte-by-byte compare leaks the digest to
 * anybody willing to make a few thousand requests. And it refuses an old
 * timestamp, because a signature with no clock on it is a signature that
 * never expires.
 *
 * Kept as a pure function with no n8n types in it, so the edge cases are
 * tested directly rather than through a webhook.
 */

/** How old a delivery may be. Jabee's own documented tolerance. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

export type SignatureCheck = { ok: true } | { ok: false; reason: string };

export function verifySignature(input: {
	header: string | undefined;
	rawBody: Buffer | string;
	secret: string;
	nowSeconds: number;
	toleranceSeconds?: number;
}): SignatureCheck {
	const { header, rawBody, secret, nowSeconds } = input;
	const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;

	if (!secret) {
		return { ok: false, reason: 'no signing secret is set on the Jabee credential' };
	}
	if (!header) {
		return { ok: false, reason: 'the X-Jabee-Signature header is missing' };
	}

	const parts = new Map<string, string>();
	for (const piece of header.split(',')) {
		const at = piece.indexOf('=');
		if (at > 0) parts.set(piece.slice(0, at).trim(), piece.slice(at + 1).trim());
	}

	const timestamp = Number(parts.get('t'));
	const provided = parts.get('v1');
	if (!Number.isFinite(timestamp) || !provided) {
		return { ok: false, reason: 'the X-Jabee-Signature header is not t=<unix>,v1=<hex>' };
	}

	/**
	 * Both directions. A delivery from the future is as wrong as an old
	 * one, and usually means one of the two clocks has drifted -- which is
	 * worth saying out loud rather than passing.
	 */
	if (Math.abs(nowSeconds - timestamp) > tolerance) {
		return {
			ok: false,
			reason: `the signature is timestamped ${Math.round(Math.abs(nowSeconds - timestamp))}s away from now, past the ${tolerance}s tolerance`,
		};
	}

	const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
	const expected = createHmac('sha256', secret)
		.update(Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), body]))
		.digest('hex');

	const a = Buffer.from(expected, 'utf8');
	const b = Buffer.from(provided, 'utf8');
	/**
	 * Lengths first, because `timingSafeEqual` throws on a mismatch
	 * rather than returning false, and a truncated signature would then
	 * be a 500 instead of a refusal.
	 */
	if (a.length !== b.length || !timingSafeEqual(a, b)) {
		return { ok: false, reason: 'the signature does not match the body' };
	}

	return { ok: true };
}
