#!/usr/bin/env node
/**
 * Records the install and configuration movie (an MP4 that isn't committed) with the shared Supertext
 * movie kit (movie/movie-kit.mjs): the install commands from docs/INSTALLATION.md in a terminal, then,
 * as the demo's administrator, the module bar, the Supertext page (API key, Test connection, language
 * mapping) and the Supertext translation interface in the data model. Run it against a demo whose
 * SUPERTEXT_API_URL points at the stand-in API (stand-in.mjs). See docs/DEVELOPER.md.
 *
 *   DIRECTUS_URL=http://127.0.0.1:8055 ADMIN_EMAIL=… ADMIN_PASSWORD=… node movie-install.mjs
 *
 * MOVIE_OUT: where the MP4 goes (default test/docs/movie/out/Directus-Supertext-Translation-install.mp4, git-ignored).
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MovieKit } from './movie/movie-kit.mjs';

const B = process.env.DIRECTUS_URL ?? 'http://127.0.0.1:8055';
const need = (name) => process.env[name] ?? (() => { throw new Error(`Set ${name}`); })();
const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const mp4 = process.env.MOVIE_OUT ?? here('movie/out/Directus-Supertext-Translation-install.mp4');
const workDir = mkdtempSync(join(tmpdir(), 'directus-install-movie-'));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, locale: 'en-US' });
page.setDefaultTimeout(90_000);
// The movie runs against the stand-in: show the address users see instead of a local one.
await page.addInitScript(() => {
	const fix = (root) => {
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		for (let n = walker.nextNode(); n; n = walker.nextNode()) {
			if (/127\.0\.0\.1|localhost/.test(n.textContent)) n.textContent = 'https://api.supertext.com/v1/';
		}
	};
	new MutationObserver(() => document.body && fix(document.body)).observe(document, { subtree: true, childList: true, characterData: true });
});

// Sign in and close the administrator's first-login prompts (not recorded).
await page.goto(`${B}/admin/login`);
await page.fill('input[type=email]', need('ADMIN_EMAIL'));
await page.fill('input[type=password]', need('ADMIN_PASSWORD'));
await page.click('button[type=submit]');
await page.waitForURL(/admin\/(?!login)/);
for (let i = 0; i < 3; i++) {
	await page.waitForTimeout(1000);
	const skip = page.getByRole('button', { name: /^(Skip|Remind Later)$/ });
	if (!(await skip.count())) break;
	await skip.first().click();
}

/** Directus scrolls inside its main panel: bring an element into view, smoothly. */
const scrollTo = async (locator, block = 'start') => {
	await locator.evaluate((el, block) => el.scrollIntoView({ block, behavior: 'smooth' }), block);
	await page.waitForTimeout(900);
};

const kit = await MovieKit.start(page, { workDir, assets: here('movie/assets'), voiceCache: here('movie/voice') });
const ext = 'directus-extension-supertext-translation';

// 1. Install from the repository (docs/INSTALLATION.md → Install).
await kit.say('First, clone the extension from GitHub. Go into its folder, install its dependencies with npm, and build it.', {
	caption: 'Get the extension and build it',
	during: () => kit.terminal({
		title: 'my-site',
		lines: [
			{ cmd: 'git clone https://github.com/Supertext/Directus-Supertext-Translation.git' },
			{ out: "Cloning into 'Directus-Supertext-Translation'..." },
			{ cmd: 'cd Directus-Supertext-Translation' },
			{ cmd: 'npm ci && npm run build' },
			{ out: 'added 483 packages in 12s' },
			{ out: '✔ Done' },
		],
	}),
});
await kit.say("Copy the package file and the dist folder into the extensions folder of your Directus project.", {
	caption: 'Copy <b>package.json</b> and <b>dist</b> to <b>extensions/</b>',
	during: () => kit.terminal({
		title: 'my-site',
		lines: [
			{ cmd: `EXT=../my-site/extensions/${ext}` },
			{ cmd: 'mkdir -p $EXT && cp -r package.json dist $EXT/' },
		],
	}),
});
await kit.say('In your Directus project, add your Supertext API key to the environment, as SUPERTEXT_API_KEY. Then restart Directus. The log lists the extension.', {
	caption: 'Set <b>SUPERTEXT_API_KEY</b> and restart Directus',
	during: () => kit.terminal({
		title: 'my-site',
		lines: [
			{ cmd: 'cd ../my-site' },
			{ cmd: "echo 'SUPERTEXT_API_KEY=st-demo-0000-0000-0000' >> .env" },
			{ cmd: 'npx directus start' },
			{ out: `INFO: Loaded extensions: ${ext}`, wait: 400 },
			{ out: 'INFO: Server started' },
		],
	}),
});

/** Opens a page without recording the loading. */
const open = async (path, ready) => {
	kit.pause();
	await page.goto(B + path);
	if (ready) await ready();
	await page.waitForTimeout(1200);
	kit.resume();
};

// 2. Languages must exist (Directus's own setup).
await open('/admin/content/languages', () => page.getByText('Deutsch (Schweiz)').first().waitFor());
await kit.say("Languages come from Directus's own languages collection. Set it up first.", {
	caption: 'Languages: Directus’s <b>languages</b> collection and <b>Translations</b> fields',
});

// 3. Switch the module on.
await open('/admin/settings/project', () => page.getByText('Module Bar').first().waitFor());
const moduleRow = page.locator('.info').filter({ has: page.locator('.to', { hasText: /^\/supertext$/ }) }).first();
await kit.say('Directus hides new modules. Under Settings, Settings, Module Bar, switch on Supertext.', {
	caption: '<b>Settings → Settings → Module Bar</b>: switch on <b>Supertext</b>',
	during: async () => {
		await scrollTo(moduleRow, 'center');
		await kit.moveTo(moduleRow);
	},
});

// 4. The Supertext page: the key.
await kit.say('Then open the Supertext page in the module bar. The API key is set.', {
	caption: 'Open the <b>Supertext</b> page: the API key is set',
	during: async () => {
		await kit.click(page.locator('a[href="/admin/supertext"]').first());
		await page.getByText('Plugin version').waitFor();
		await page.waitForTimeout(600);
		await kit.moveTo(page.getByText('Set (SUPERTEXT_API_KEY)'));
	},
});
await kit.say('Generate your API key at supertext.com, Integrations, API. No account yet? Create one at supertext.com.', {
	caption: 'Generate your API key at <b>supertext.com → Integrations → API</b>. No account yet? Create one at supertext.com.',
	during: () => kit.moveTo(page.locator('.key-help a').last()),
});

// 5. Test connection.
await kit.say('Click Test connection. The connection to Supertext works.', {
	caption: '<b>Test connection</b>: the API key works',
	during: async () => {
		await kit.click(page.getByRole('button', { name: 'Test connection' }));
		await page.getByText('API key checked: the connection to Supertext works.').waitFor();
		await kit.moveTo(page.getByText('API key checked: the connection to Supertext works.'));
	},
});

// 6. Language mapping.
const deRow = page.locator('table.languages tr').filter({ hasText: 'de-CH' });
await kit.say('Under Languages, each Directus language gets a Supertext language. For German, choose Swiss High German.', {
	caption: '<b>Languages</b>: choose the Supertext language for each language',
	during: async () => {
		await scrollTo(page.locator('.supertext-module h2').filter({ hasText: 'Languages' }));
		await scrollTo(page.locator('table.languages'));
		await kit.click(deRow.locator('.target-select .v-input').first());
		await page.waitForTimeout(400);
		await page.keyboard.type('Swiss', { delay: 90 });
		await page.waitForTimeout(500);
		await kit.click(page.locator('.v-list-item').filter({ hasText: 'Swiss High German (de-CH)' }).first());
	},
});
await kit.say('Translation review can be ticked for each language. Leave it off for now.', {
	caption: '<b>Translation review</b>: optional, per language',
	during: () => kit.moveTo(deRow.locator('.review-checkbox')),
});
// Short caption: the Save button sits at the bottom of the page, next to the caption bar.
await kit.say('Click Save languages.', {
	caption: 'Click <b>Save languages</b>',
	during: async () => {
		const save = page.getByRole('button', { name: 'Save languages' });
		await scrollTo(save, 'center');
		await kit.click(save);
		await page.getByText('Saved.', { exact: true }).waitFor();
	},
});

// 7. The translate box on a collection (docs/INSTALLATION.md → Add the translate box to a collection).
await open('/admin/settings/data-model/articles', () => page.getByText('Create Field', { exact: true }).first().waitFor());
await kit.say('To add the translate box to a collection: Settings, Data Model, the collection, Create Field.', {
	caption: '<b>Settings → Data Model</b> → your collection → <b>Create Field</b>',
	during: async () => {
		await kit.click(page.getByText('Create Field', { exact: true }).first());
		await page.waitForTimeout(800);
	},
});
await kit.say('Choose Supertext translation, and place it above the Translations field.', {
	caption: 'Choose <b>Supertext translation</b>',
	during: async () => {
		await page.keyboard.type('Supertext', { delay: 90 });
		await page.waitForTimeout(700);
		await kit.moveTo(page.locator('.v-drawer').getByText('Supertext translation', { exact: true }).first());
	},
});

// 8. Where editors find it (the demo already has the field).
await open('/admin/content/articles/1', async () => {
	await page.locator('.supertext .targets').waitFor();
	await page.locator('.field').filter({ has: page.getByText('Translations', { exact: true }) }).last().getByText('English', { exact: true }).first().waitFor();
});
await kit.say('Done. Editors now find Translate with Supertext on every article.', {
	caption: 'Editors find <b>Translate with Supertext</b> on the item',
	during: () => kit.moveTo(page.locator('.supertext').getByText('Translate with Supertext').first()),
});
await kit.caption('');

await kit.finish(mp4, { system: 'Directus', repo: 'Directus-Supertext-Translation', kind: 'install' });
await browser.close();
rmSync(workDir, { recursive: true, force: true });
console.log(`Saved ${mp4}`);
