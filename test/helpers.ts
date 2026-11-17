import { vi } from 'vitest';
import type {
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	INode,
	INodeExecutionData,
	IWebhookFunctions,
} from 'n8n-workflow';

/**
 * Enough of n8n to drive a node, and nothing more.
 *
 * n8n's own suites mock these interfaces rather than booting an instance,
 * and the parts a node actually touches are small: the parameters, the
 * input items, the credential, and the one HTTP helper. Everything here
 * behaves the way the real thing does on the paths the nodes take --
 * `getNodeParameter` honours its fallback, `continueOnFail` is read
 * rather than assumed, and `constructExecutionMetaData` really attaches
 * `pairedItem`, because a node that loses that is a node whose errors
 * point at the wrong row.
 */

export const NODE: INode = {
	id: 'node-1',
	name: 'Jabee',
	type: 'n8n-nodes-jabee.jabee',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

export interface FakeHttpResponse {
	statusCode: number;
	headers?: Record<string, string | string[] | undefined>;
	body?: unknown;
}

export function ok(body: unknown, statusCode = 200): FakeHttpResponse {
	return { statusCode, headers: {}, body };
}

export function fail(
	statusCode: number,
	body: unknown,
	headers: Record<string, string> = {},
): FakeHttpResponse {
	return { statusCode, headers, body };
}

export interface FakeExecuteOptions {
	params: Record<string, unknown>;
	items?: IDataObject[];
	responses: FakeHttpResponse[];
	credentials?: IDataObject;
	continueOnFail?: boolean;
}

export interface FakeExecute {
	fn: IExecuteFunctions;
	/** Every call made, as `[credentialType, requestOptions]`. */
	calls: Array<[string, Record<string, unknown>]>;
}

export function fakeExecute(options: FakeExecuteOptions): FakeExecute {
	const calls: Array<[string, Record<string, unknown>]> = [];
	const queue = [...options.responses];
	const items: INodeExecutionData[] = (options.items ?? [{}]).map((json) => ({ json }));

	const httpRequestWithAuthentication = vi.fn(
		async (credentialType: string, requestOptions: Record<string, unknown>) => {
			calls.push([credentialType, requestOptions]);
			const next = queue.shift();
			if (!next) {
				throw new Error(
					`the node made more HTTP calls than the test queued: ${String(requestOptions.method)} ${String(requestOptions.url)}`,
				);
			}
			return { statusCode: next.statusCode, headers: next.headers ?? {}, body: next.body ?? {} };
		},
	);

	const fn = {
		getInputData: () => items,
		getNode: () => NODE,
		continueOnFail: () => options.continueOnFail ?? false,
		getCredentials: async () =>
			options.credentials ?? { apiKey: 'jak_test', baseUrl: 'https://api.jabee.ai/api/v1' },
		getNodeParameter: (name: string, _itemIndex: number, fallback?: unknown) => {
			if (name in options.params) return options.params[name];
			if (fallback !== undefined) return fallback;
			throw new Error(`the node asked for a parameter the test did not set: ${name}`);
		},
		logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
		helpers: {
			httpRequestWithAuthentication,
			returnJsonArray: (json: IDataObject | IDataObject[]): INodeExecutionData[] =>
				(Array.isArray(json) ? json : [json]).map((one) => ({ json: one })),
			constructExecutionMetaData: (
				input: INodeExecutionData[],
				meta: { itemData: { item: number } },
			) => input.map((one) => ({ ...one, pairedItem: meta.itemData })),
		},
	} as unknown as IExecuteFunctions;

	return { fn, calls };
}

export interface FakeWebhookOptions {
	params: Record<string, unknown>;
	body: unknown;
	rawBody?: Buffer | string;
	headers?: Record<string, string | string[] | undefined>;
	credentials?: IDataObject;
	/** What `create` left behind on a previous activation. */
	staticData?: IDataObject;
}

export interface FakeWebhook {
	fn: IWebhookFunctions;
	/** What was written to the HTTP response, when anything was. */
	response: { status: number | null; sent: unknown };
	warnings: string[];
	/** The node's static data, read back after the call. */
	staticData: IDataObject;
}

export function fakeWebhook(options: FakeWebhookOptions): FakeWebhook {
	const response: { status: number | null; sent: unknown } = { status: null, sent: null };
	const warnings: string[] = [];
	const raw =
		options.rawBody ?? Buffer.from(JSON.stringify(options.body ?? {}), 'utf8');

	const res = {
		status(code: number) {
			response.status = code;
			return this;
		},
		send(payload: unknown) {
			response.sent = payload;
			return this;
		},
		end() {
			return this;
		},
	};

	const staticData: IDataObject = { ...(options.staticData ?? {}) };

	const fn = {
		getNode: () => ({ ...NODE, type: 'n8n-nodes-jabee.jabeeTrigger' }),
		getCredentials: async () => options.credentials ?? { webhookSecret: '' },
		getWorkflowStaticData: () => staticData,
		getNodeParameter: (name: string, fallback?: unknown) => {
			if (name in options.params) return options.params[name];
			if (fallback !== undefined) return fallback;
			throw new Error(`the node asked for a parameter the test did not set: ${name}`);
		},
		getBodyData: () => (options.body ?? {}) as IDataObject,
		getHeaderData: () => options.headers ?? {},
		getRequestObject: () => ({ rawBody: raw }),
		getResponseObject: () => res,
		logger: {
			warn: (message: string) => warnings.push(message),
			info: vi.fn(),
			debug: vi.fn(),
			error: vi.fn(),
		},
		helpers: {
			returnJsonArray: (json: IDataObject | IDataObject[]): INodeExecutionData[] =>
				(Array.isArray(json) ? json : [json]).map((one) => ({ json: one })),
		},
	} as unknown as IWebhookFunctions;

	return { fn, response, warnings, staticData };
}

export interface FakeHookOptions {
	/** The Production URL n8n would hand the node, or nothing at all. */
	webhookUrl?: string | undefined;
	responses: FakeHttpResponse[];
	credentials?: IDataObject;
	staticData?: IDataObject;
}

export interface FakeHook {
	fn: IHookFunctions;
	/** Every call made, as `[credentialType, requestOptions]`. */
	calls: Array<[string, Record<string, unknown>]>;
	/** The node's static data, which is where a registered secret lives. */
	staticData: IDataObject;
	warnings: string[];
}

/**
 * Enough of n8n to run `checkExists`, `create` and `delete`.
 *
 * The same shape as `fakeExecute`: a queue of HTTP answers, every request
 * recorded, and nothing mocked that the methods do not touch. `staticData`
 * is a real object held across the calls, because what `create` writes
 * into it is what `webhook()` later verifies with.
 */
export function fakeHook(options: FakeHookOptions): FakeHook {
	const calls: Array<[string, Record<string, unknown>]> = [];
	const queue = [...options.responses];
	const staticData: IDataObject = { ...(options.staticData ?? {}) };
	const warnings: string[] = [];

	const httpRequestWithAuthentication = vi.fn(
		async (credentialType: string, requestOptions: Record<string, unknown>) => {
			calls.push([credentialType, requestOptions]);
			const next = queue.shift();
			if (!next) {
				throw new Error(
					`the node made more HTTP calls than the test queued: ${String(requestOptions.method)} ${String(requestOptions.url)}`,
				);
			}
			return { statusCode: next.statusCode, headers: next.headers ?? {}, body: next.body ?? {} };
		},
	);

	const fn = {
		getNode: () => ({ ...NODE, type: 'n8n-nodes-jabee.jabeeTrigger' }),
		getNodeWebhookUrl: () =>
			'webhookUrl' in options ? options.webhookUrl : 'https://n8n.example.com/webhook/jabee',
		getCredentials: async () =>
			options.credentials ?? { apiKey: 'jak_test', baseUrl: 'https://api.jabee.ai/api/v1' },
		getWorkflowStaticData: () => staticData,
		logger: {
			warn: (message: string) => warnings.push(message),
			info: vi.fn(),
			debug: vi.fn(),
			error: vi.fn(),
		},
		helpers: { httpRequestWithAuthentication },
	} as unknown as IHookFunctions;

	return { fn, calls, staticData, warnings };
}
