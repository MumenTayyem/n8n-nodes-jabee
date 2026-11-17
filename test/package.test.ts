/*
 * This file reads the package's own files, so it uses `node:fs`,
 * `node:path` and `__dirname` -- all three banned in a node that runs on
 * n8n Cloud, and none of them shipped: the rules exist for `nodes/` and
 * `credentials/`, which is exactly what this test is checking.
 */
/* eslint-disable @n8n/community-nodes/no-restricted-imports */
/* eslint-disable @n8n/community-nodes/no-restricted-globals */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { JabeeApi } from '../credentials/JabeeApi.credentials';
import { Jabee } from '../nodes/Jabee/Jabee.node';
import { JabeeTrigger } from '../nodes/Jabee/JabeeTrigger.node';

/**
 * The checks that catch a package n8n will install and then not show.
 *
 * None of this is clever, and all of it has bitten published community
 * nodes: an `n8n` block pointing at a file the build does not emit, a
 * name that does not begin `n8n-nodes-`, a missing keyword that keeps the
 * package out of the registry's search, a runtime dependency that fails
 * verification, and an icon referenced by a filename nobody added.
 */
const root = path.join(__dirname, '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
	name: string;
	license: string;
	keywords: string[];
	dependencies?: Record<string, string>;
	n8n: { n8nNodesApiVersion: number; strict?: boolean; nodes: string[]; credentials: string[] };
};

describe('the package n8n will load', () => {
	it('is named and keyworded the way the registry looks for', () => {
		expect(pkg.name.startsWith('n8n-nodes-')).toBe(true);
		expect(pkg.keywords).toContain('n8n-community-node-package');
		expect(pkg.license).toBe('MIT');
		expect(pkg.n8n.n8nNodesApiVersion).toBe(1);
	});

	it('ships no runtime dependencies, which verification refuses', () => {
		expect(pkg.dependencies ?? {}).toEqual({});
	});

	it('points the n8n block at a source file that exists for every built path', () => {
		for (const entry of [...pkg.n8n.nodes, ...pkg.n8n.credentials]) {
			const source = entry.replace(/^dist\//, '').replace(/\.js$/, '.ts');
			expect(existsSync(path.join(root, source)), `${entry} has no source at ${source}`).toBe(true);
		}
	});

	it('carries no codex file beside the source, which the build would not copy', () => {
		// `n8n-node build` copies only png, svg and `__schema__` JSON, so
		// a `*.node.json` here would be metadata that never ships. Both
		// nodes declare `codex` inline instead, asserted below.
		for (const entry of pkg.n8n.nodes) {
			const codexPath = entry.replace(/^dist\//, '').replace(/\.js$/, '.json');
			expect(existsSync(path.join(root, codexPath))).toBe(false);
		}
	});
});

describe('the two nodes', () => {
	const nodes = [new Jabee().description, new JabeeTrigger().description];

	it('reference a light and a dark icon file that are both in the package', () => {
		for (const description of nodes) {
			const icon = description.icon as { light: string; dark: string };
			expect(Object.keys(icon).sort()).toEqual(['dark', 'light']);
			for (const reference of [icon.light, icon.dark]) {
				expect(reference.startsWith('file:')).toBe(true);
				expect(
					existsSync(path.join(root, 'nodes/Jabee', reference.slice('file:'.length))),
					`${reference} is referenced but not in nodes/Jabee`,
				).toBe(true);
			}
		}
	});

	it('reference credential icons that are in the credentials directory', () => {
		// A different directory, because n8n resolves `file:` against the
		// file that names it, so the credential cannot borrow the node's.
		const icon = new JabeeApi().icon as { light: string; dark: string };
		for (const reference of [icon.light, icon.dark]) {
			expect(existsSync(path.join(root, 'credentials', reference.slice('file:'.length)))).toBe(true);
		}
	});

	it('declares its category and documentation link inline, so dist carries them', () => {
		for (const description of nodes) {
			expect(description.codex?.categories).toContain('Communication');
			expect(description.codex?.resources?.primaryDocumentation?.[0]?.url).toContain(
				'jabee.ai/docs/n8n/',
			);
		}
	});

	it('both require the one credential, so an account is set up once', () => {
		for (const description of nodes) {
			expect(description.credentials).toEqual([{ name: 'jabeeApi', required: true }]);
			expect(description.credentials?.[0]?.name).toBe(new JabeeApi().name);
		}
	});

	it('gives the trigger no inputs and the action node one', () => {
		expect(nodes[0]?.inputs).toHaveLength(1);
		expect(nodes[1]?.inputs).toHaveLength(0);
		expect(nodes[1]?.webhooks).toEqual([
			{ name: 'default', httpMethod: 'POST', responseMode: 'onReceived', path: 'webhook' },
		]);
	});

	it('offers only operations the API has', () => {
		// Written out rather than derived, so adding a route to the node
		// without a route at the API fails here.
		const operations = (nodes[0]?.properties ?? [])
			.filter((property) => property.name === 'operation')
			.flatMap((property) => (property.options ?? []).map((option) => (option as { value: string }).value));

		expect(operations.sort()).toEqual(
			['cancel', 'checkIn', 'get', 'getAll', 'reportOutcome', 'request', 'revise', 'send'].sort(),
		);
	});
});

describe('the credential', () => {
	const credential = new JabeeApi();

	it('sends the key as a bearer header and never in the query string', () => {
		expect(credential.authenticate).toEqual({
			type: 'generic',
			properties: { headers: { Authorization: '=Bearer {{$credentials.apiKey}}' } },
		});
	});

	it('tests itself with a read, so pressing the button messages nobody', () => {
		expect(credential.test.request.method).toBe('GET');
		expect(credential.test.request.url).toBe('/approvals');
	});

	it('keeps both secrets out of the UI as plain text', () => {
		for (const name of ['apiKey', 'webhookSecret']) {
			const property = credential.properties.find((one) => one.name === name);
			expect(property?.typeOptions?.password, `${name} is not a password field`).toBe(true);
		}
	});

	it('defaults to the live API', () => {
		const baseUrl = credential.properties.find((one) => one.name === 'baseUrl');
		expect(baseUrl?.default).toBe('https://api.jabee.ai/api/v1');
	});
});
