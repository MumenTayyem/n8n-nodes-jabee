import { defineConfig } from 'vitest/config';

export default defineConfig({
	/**
	 * `n8n-workflow` ships source maps that point at files it does not
	 * publish, and Vite warns once per module about every one of them --
	 * about forty lines of noise above the only output that matters. The
	 * level is `error` rather than `silent` so a real failure is still
	 * printed.
	 */
	logLevel: 'error',
	test: {
		include: ['test/**/*.test.ts'],
	},
});
