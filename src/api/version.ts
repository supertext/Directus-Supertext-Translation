import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = 'directus-extension-supertext-translation';
let cached: string | null | undefined;

/**
 * The extension's version, read at runtime from its own package.json (the only place it is
 * kept). Looks upwards from this file, so it works from `src/` (tests) and from the built
 * `dist/api.js` next to the installed package.json. Null if it can't be found.
 */
export function extensionVersion(start: string = dirname(fileURLToPath(import.meta.url))): string | null {
	if (cached !== undefined && arguments.length === 0) return cached;
	let version: string | null = null;
	for (let dir = start, i = 0; i < 6; i++) {
		const file = join(dir, 'package.json');
		if (existsSync(file)) {
			try {
				const pkg = JSON.parse(readFileSync(file, 'utf8'));
				if (pkg?.name === PACKAGE_NAME && typeof pkg.version === 'string') {
					version = pkg.version;
					break;
				}
			} catch {
				// unreadable package.json: keep looking
			}
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	if (arguments.length === 0) cached = version;
	return version;
}


/** The User-Agent for Supertext requests: `Directus-Supertext-Translation/<version>` (version as in the reports). */
export function userAgent(): string {
	return `Directus-Supertext-Translation/${extensionVersion() ?? '0.0.0'}`;
}
