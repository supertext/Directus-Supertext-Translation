#!/usr/bin/env node
/**
 * Records the README's demo movie (docs/images/demo.gif, plus an MP4 that isn't committed)
 * from a fresh demo whose SUPERTEXT_API_URL points at the stand-in API (stand-in.mjs), with
 * the editor account. Uses the shared Supertext movie kit (movie/movie-kit.mjs). See docs/DEVELOPER.md.
 *
 *   DIRECTUS_URL=http://127.0.0.1:8055 EDITOR_EMAIL=… EDITOR_PASSWORD=… node movie.mjs
 *
 * MOVIE_OUT: where the MP4 goes (default test/docs/movie/out/Directus-Supertext-Translation.mp4, git-ignored).
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MovieKit } from './movie/movie-kit.mjs';

const B = process.env.DIRECTUS_URL ?? 'http://127.0.0.1:8055';
const need = (name) => process.env[name] ?? (() => { throw new Error(`Set ${name}`); })();
const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const mp4 = process.env.MOVIE_OUT ?? here('movie/out/Directus-Supertext-Translation.mp4');
const gif = here('../../docs/images/demo.gif');
const workDir = mkdtempSync(join(tmpdir(), 'directus-movie-'));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, locale: 'en-US' });
page.setDefaultTimeout(90_000);

// Sign in (not recorded).
await page.goto(`${B}/admin/login`);
await page.fill('input[type=email]', need('EDITOR_EMAIL'));
await page.fill('input[type=password]', need('EDITOR_PASSWORD'));
await page.click('button[type=submit]');
await page.waitForURL(/admin\/(?!login)/);
await page.goto(`${B}/admin/content/articles/1`);
const box = page.locator('.supertext');
await box.locator('.targets').waitFor();
await page.waitForTimeout(800);

/** The form field whose label is exactly `label`. */
const field = (label) => page.locator('.field').filter({ has: page.getByText(label, { exact: true }) }).last();
/** Directus scrolls inside its main panel: bring an element to the top, smoothly. */
const scrollTo = async (locator, block = 'start') => {
	await locator.evaluate((el, block) => el.scrollIntoView({ block, behavior: 'smooth' }), block);
	await page.waitForTimeout(900);
};

const kit = await MovieKit.start(page, { workDir, assets: here('movie/assets'), voiceCache: here('movie/voice') });

// 1. The article in English.
await kit.say("Here's an article in Directus, written in English.", {
	caption: 'An article in English',
	during: async () => {
		await scrollTo(field('Title'));
		await kit.hold(900);
		await scrollTo(page.locator('.v-form').first());
	},
});

// 2. Choose the languages in the Supertext box: German and French (Italian unticked).
const tick = (code) => box.locator('.target').filter({ hasText: code }).locator('.v-checkbox .v-icon').first();
await kit.say('In the Translate with Supertext box, keep German and French ticked.', {
	caption: '<b>Translate with Supertext</b>: choose the languages',
	during: async () => {
		await kit.click(tick('it-CH'));
		await kit.moveTo(tick('de-CH'));
	},
});

// 3. Translate.
await kit.say('Then click Translate.', { caption: 'Click <b>Translate</b>', during: () => kit.click(box.locator('.actions').getByRole('button').first()) });

// 4. Waiting.
await kit.say('Supertext translates the content.', { caption: 'Supertext translates the content…', during: () => box.locator('.hint').waitFor() });
kit.pause();
await box.locator('.result').first().waitFor({ timeout: 180_000 });
await page.waitForTimeout(400);
kit.resume();
await kit.say('A few seconds later, German and French are in the form.', {
	caption: 'German and French are in the form',
	during: async () => {
		await kit.hold(1200);
		await scrollTo(field('Translations'));
	},
});

// 5. The German version, then save.
await kit.say('To check the German version, switch the Translations field to German.', {
	caption: 'Switch the <b>Translations</b> field to German',
	during: async () => {
		await kit.click(field('Translations').getByText('English', { exact: true }).first());
		await page.waitForTimeout(300);
		await kit.click(page.locator('.v-list-item, [role=menuitem], li').filter({ hasText: 'Deutsch' }).first());
		await page.waitForTimeout(600);
		await scrollTo(field('Translations'));
	},
});
await kit.say('The German version is ready. Review it, just like your own text.', { caption: 'The German version is ready – review it' });
await kit.say("When you're happy with it, open the Save menu and click Save and Stay.", {
	caption: 'Save with <b>Save and Stay</b>',
	during: async () => {
		await kit.click(page.getByRole('button', { name: 'More options' }).first());
		await page.waitForTimeout(300);
		await kit.click(page.locator('.v-list-item').filter({ hasText: 'Save and Stay' }).first());
		await page.waitForTimeout(800);
	},
});
await kit.say('Done. The article now speaks German and French.', { caption: 'Saved: the article now has German and French' });
await kit.caption('');

await kit.finish(mp4, { system: 'Directus', repo: 'Directus-Supertext-Translation', gif });
await browser.close();
rmSync(workDir, { recursive: true, force: true });
console.log(`Saved ${mp4} and ${gif} (${(statSync(gif).size / 1e6).toFixed(2)} MB)`);
