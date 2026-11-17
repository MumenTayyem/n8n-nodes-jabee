import type {
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, sleep } from 'n8n-workflow';

/** Where the sleeping and the clock-reading happen, so a test can skip both.
 *
 * Both poll loops below wait for real seconds. Injecting them through the
 * node's parameters would put a knob in the UI that exists for the test
 * suite, so they live here instead and a test overwrites the two fields.
 */
export const timing = {
	sleep: async (ms: number): Promise<void> => sleep(ms),
	now: (): number => Date.now(),
};

/**
 * Whatever the Jabee context is: both nodes, the credential test, and the
 * trigger's own `webhookMethods`, which register the webhook address over
 * the same transport on activation.
 */
export type JabeeContext = IExecuteFunctions | ILoadOptionsFunctions | IHookFunctions;

export interface JabeeResponse {
	statusCode: number;
	headers: Record<string, string | string[] | undefined>;
	body: IDataObject;
}

/**
 * How many times a per-key rate limit is waited out before giving up.
 *
 * The limit is 60 calls a minute per key. A workflow fed a list of items
 * reaches it on its own, and the fix is one short wait rather than a
 * failed execution.
 */
const RATE_LIMIT_RETRIES = 2;

/**
 * The 429s that waiting cannot clear, so they are thrown at once.
 *
 * Jabee answers 429 for four different things and only the per-minute one
 * is worth a pause. A day, an hour and a count of checks are all longer
 * than an execution should sit there sleeping, and the sentence that comes
 * back names the fix.
 */
const UNWAITABLE_429 = new Set([
	'daily_limit_reached',
	'webhook_limit_reached',
	'heartbeat_limit_reached',
]);

/** Clamp on `Retry-After`, in seconds, so a bad header cannot park a workflow. */
const MIN_RETRY_AFTER = 1;
const MAX_RETRY_AFTER = 30;

/** Jabee's error bodies are `{ error, detail, field }`. */
interface JabeeErrorBody {
	error?: string;
	detail?: string;
	field?: string | null;
}

/**
 * One call to the Jabee API, with the status code handed back rather than
 * thrown.
 *
 * `ignoreHttpStatusErrors` is on deliberately. Jabee answers a refusal
 * with a code and a sentence written for the person who has to fix it --
 * "allowance_used_up: 500 approvals and alerts a month are included" is
 * worth far more than "402" -- and the only way to read that body is to
 * stop n8n throwing before we see it.
 */
export async function jabeeApiRequestRaw(
	this: JabeeContext,
	method: IHttpRequestMethods,
	path: string,
	body?: IDataObject,
	qs?: IDataObject,
): Promise<JabeeResponse> {
	const credentials = await this.getCredentials('jabeeApi');
	const baseUrl = String(credentials.baseUrl ?? 'https://api.jabee.ai/api/v1').replace(/\/+$/, '');

	const options: IHttpRequestOptions = {
		method,
		url: `${baseUrl}${path}`,
		json: true,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
		timeout: 30_000,
		headers: { Accept: 'application/json' },
		...(body === undefined ? {} : { body }),
		...(qs === undefined ? {} : { qs }),
	};

	for (let attempt = 0; ; attempt++) {
		const response = (await this.helpers.httpRequestWithAuthentication.call(
			this,
			'jabeeApi',
			options,
		)) as JabeeResponse;

		const payload = (response.body ?? {}) as JabeeErrorBody;
		const retryable =
			response.statusCode === 429 &&
			!UNWAITABLE_429.has(payload.error ?? '') &&
			attempt < RATE_LIMIT_RETRIES;

		if (!retryable) return response;

		await timing.sleep(retryAfterMs(response.headers['retry-after']));
	}
}

/** `Retry-After` in milliseconds, clamped, defaulting to two seconds. */
export function retryAfterMs(header: string | string[] | undefined): number {
	const raw = Array.isArray(header) ? header[0] : header;
	const seconds = Number(raw);
	if (!Number.isFinite(seconds)) return 2_000;
	return Math.min(Math.max(seconds, MIN_RETRY_AFTER), MAX_RETRY_AFTER) * 1_000;
}

/**
 * The same call, with anything but a 2xx turned into a node error.
 *
 * The message carries Jabee's own code and sentence, because the person
 * reading it in n8n's execution log is the person who has to act on it,
 * and `field` names the parameter they typed wrong.
 */
export async function jabeeApiRequest(
	this: JabeeContext,
	method: IHttpRequestMethods,
	path: string,
	body?: IDataObject,
	qs?: IDataObject,
): Promise<IDataObject> {
	const response = await jabeeApiRequestRaw.call(this, method, path, body, qs);

	if (response.statusCode >= 200 && response.statusCode < 300) {
		return (response.body ?? {}) as IDataObject;
	}

	const payload = (response.body ?? {}) as JabeeErrorBody;
	const code = payload.error ?? `http_${response.statusCode}`;
	const detail = payload.detail ?? FALLBACK_DETAIL[code] ?? `Jabee answered ${response.statusCode}.`;

	throw new NodeApiError(this.getNode(), (response.body ?? {}) as JsonObject, {
		message: `${code}: ${detail}`,
		...(payload.field ? { description: `The field at fault is '${payload.field}'.` } : {}),
		httpCode: String(response.statusCode),
	});
}

/**
 * Sentences for the refusals Jabee answers without a `detail`.
 *
 * Every other code carries its own, written at the API. These three are
 * the bare ones, and each has an action: get a new key, buy the plan,
 * check which product the id belongs to.
 */
const FALLBACK_DETAIL: Record<string, string> = {
	unauthorised: 'That API key is not valid or was revoked. Make a new one under Management then Approvals.',
	webhook_failed: 'Jabee could not read or change the webhook address. Try activating again.',
	not_found:
		'No request of that kind has that ID on this account. An alert ID is not found under approvals, and the other way round.',
	allowance_used_up:
		'The monthly allowance is used up. Approvals and alerts are counted together, and overage can be turned on in the dashboard.',
};

/**
 * Wait for somebody to answer, or for the request to run out of time.
 *
 * Polling, because Jabee's webhook address is one setting on the account
 * rather than something a single execution can hand out, so there is no
 * per-execution URL to be called back on. Use the Jabee Trigger node when
 * the wait is long enough that holding an execution open is the wrong
 * shape.
 *
 * The interval starts at two seconds, because most answers arrive within
 * a minute of the phone buzzing, and backs off to thirty so that a
 * request nobody looks at until the afternoon does not spend the key's
 * whole rate limit getting there.
 */
export const FIRST_POLL_MS = 2_000;
export const MAX_POLL_MS = 30_000;
const POLL_GROWTH = 1.6;

export async function waitForAnswer(
	read: () => Promise<IDataObject>,
	timeoutMs: number,
): Promise<IDataObject> {
	const deadline = timing.now() + timeoutMs;
	let wait = FIRST_POLL_MS;

	for (;;) {
		const approval = await read();
		if (approval.status !== 'pending') return approval;
		/**
		 * Checked before sleeping rather than after, so the loop never
		 * waits past a deadline it already knows it will miss. A request
		 * still pending at the end comes back pending, with its ID: the
		 * workflow decides what that means, and nothing has been lost.
		 */
		if (timing.now() + wait >= deadline) return approval;

		await timing.sleep(wait);
		wait = Math.min(Math.round(wait * POLL_GROWTH), MAX_POLL_MS);
	}
}
