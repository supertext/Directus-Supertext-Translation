# Working on this repository

Part of Supertext's "translation plugins for the top 20 open source CMS" project. Each CMS has its own repo named `Supertext/<CMS>-Supertext-Translation`. This one is the **Directus 12** extension bundle (TypeScript + Vue, npm package `directus-extension-supertext-translation`).

## Documentation rule (always)

Every plugin repo keeps three guides, and **every change that affects behaviour, settings, installation or the code structure updates them in the same commit**:

| File | Audience | Must cover |
| --- | --- | --- |
| `docs/INSTALLATION.md` | Administrators | Requirements, install/update/uninstall, API key, language setup, all settings, troubleshooting |
| `docs/USER_GUIDE.md` | Editors | How to translate and review in the CMS's own UI, what is and isn't translated, what errors mean |
| `docs/DEVELOPER.md` | Developers | Architecture, Supertext API protocol, local setup, tests, CI/deploy, releasing, known limitations/roadmap |

Also: `README.md` stays a short overview linking the three guides, and `CHANGELOG.md` gets an entry under *Unreleased* for every user-visible change. Before finishing any task, check the docs still match the code.

## Supertext account and API key links (always)

Everywhere an administrator enters or is told about the API key — the settings field's help text, the "no API key" / "authentication failed" messages, `docs/INSTALLATION.md`, `README.md` and the demo's `.env.example` — show both links (same as the WordPress plugin):

- Create a Supertext account (or log in): https://www.supertext.com/person/en/account/signin
- Generate the AI API key: https://www.supertext.com/en/integrations/api (supertext.com → Integrations → API; requires the **Admin** role)

Wording: "No Supertext account yet? Create one at supertext.com. Generate your API key at supertext.com → Integrations → API (requires the Admin role)." In the UI, links open in a new tab (`target="_blank" rel="noopener"`); where the CMS shows plain text only, use the bare URLs. New screens or messages that mention the key get the links too.

## UI languages (always)

The plugin's own UI (buttons, panels, dialogs, settings, permissions, messages) is available in English, German, French and Italian through the CMS's own translation mechanism, so it follows the user's back-end language. New or changed strings get all four languages in the same commit. Formal address (Sie, vous, Lei), the CMS's own terms in each language, "Supertext", placeholders and URLs never translated.

## Plugin list (always)

`README.md` ends with the shared list of all Supertext plugins (between the `<!-- supertext-plugins:start -->` and `<!-- supertext-plugins:end -->` markers). It is identical in every Supertext plugin repo: when a plugin is added, renamed or its description changes, update the list in **all** repos, not just this one.

## Releases (always)

Releases are published by `.github/workflows/release.yml`: never tag or create a GitHub release by hand. To release, follow `docs/DEVELOPER.md` → *Releasing* (new version section in `CHANGELOG.md`, same number in the version files) and push to `main`. A push without a new version releases nothing.

## Repo setup (always)

Every Supertext plugin repo has, and a new one gets from the start:

- `LICENSE` matching the license its manifest declares (`composer.json`, `package.json`, `pyproject.toml`, `.csproj`, plugin header).
- `SECURITY.md`: report vulnerabilities privately through GitHub's private vulnerability reporting or support@supertext.com, never in public issues.
- `.github/dependabot.yml`: weekly updates for its package ecosystem and GitHub Actions, minor and patch updates grouped into one pull request.
- `.github/workflows/checks.yml` (actionlint + zizmor on every push and PR, dependency review on PRs) and `.github/workflows/links.yml` (lychee weekly and on docs changes; broken links open the issue "Broken links in the docs"). Third-party actions are pinned to commit SHAs.
- On GitHub: the About box filled in (one-sentence description, website https://www.supertext.com, topics), `main` protected against force-pushes and deletion, Wiki and Projects off, Dependabot alerts and private vulnerability reporting on, secret scanning with push protection and CodeQL default setup on, and the Supertext social preview image.
- A row in the plugin list (see *Plugin list*) and in the org profile (`Supertext/.github` → `profile/README.md`).

Claude sessions can't change GitHub repo settings (HTTP 403): add a new repo to Remy's setup script (`set-github-about`) instead of trying.

## Checks and alerts (always)

Before starting work in a repo, look at its open findings and fix what the task touches or what is quick: code scanning alerts (`gh api 'repos/Supertext/Directus-Supertext-Translation/code-scanning/alerts?state=open'`), secret scanning alerts (`…/secret-scanning/alerts?state=open`), open Dependabot PRs and the issue "Broken links in the docs". New workflows and workflow changes must pass actionlint and zizmor; PHP code must pass PHPStan at the repo's level. See `docs/DEVELOPER.md` → *Code quality and security checks*.

## Demo accounts rule (always)

Every demo must be usable right after deployment, without anyone registering in a browser. On **every start**, the demo creates these accounts if they don't exist yet:

| Variables | Account |
| --- | --- |
| `DEMO_ADMIN_EMAIL`, `DEMO_ADMIN_PASSWORD` | Full administrator (for Supertext staff) |
| `DEMO_EDITOR_EMAIL`, `DEMO_EDITOR_PASSWORD` | Editor-level account that can translate content in every demo language; used for automated tests and screenshots. Where the CMS has no editor role that works out of the box, use the closest role and document it. |

- Existing accounts are never modified: no password resets from variables, no duplicates on restart.
- A password that doesn't meet the CMS's own password rules skips that account with a clear warning in the log. The demo still starts.
- Values live only in the hosting platform's variables (Railway). Never in the repo, in chat or in logs. Log the variable name, never the password.
- If the CMS has a first-run "create admin" screen, these accounts replace it. Document that once `DEMO_*` is set, the screen no longer appears.
- If a demo already used CMS-specific names (e.g. `TYPO3_ADMIN_*`, `PAYLOAD_ADMIN_*`), keep them as fallbacks for `DEMO_ADMIN_*`.
- The demo also seeds its target languages and at least one sample entry in the source language, and makes sure the editor account can access every target language.
- Document the variables in `docs/DEVELOPER.md` (demo section) and in the demo's `.env.example`.

## Screenshots rule (always)

The user guide and installation guide of every plugin include screenshots of the real UI: at least the translate action before and after translating, a translated result, the overwrite or retranslate warning if there is one, the plugin's settings or configuration screen, and the CMS's language setup. Screenshots are taken from the repo's own demo with the headless browser, by a committed script (e.g. `npm run docs:screenshots`), against a stand-in API that returns real translations for the sample content, so the guides never show placeholder text. Use no real customer data, no secrets, no local URLs (show the live API endpoint). Keep the images small (1× scale, cropped to the relevant part), store them in `docs/images/`, give each one descriptive alt text, and regenerate them in the same commit whenever the UI they show changes.

## Shared Supertext protocol

AI file translation API v1, same as the WordPress plugin: POST HTML file → poll status → GET translation → DELETE. Details in `docs/DEVELOPER.md`. Never commit API keys; use the `SUPERTEXT_API_KEY` environment variable.

Lessons from testing against the live API (October 2026), to apply in every plugin:

- **Auth header:** `Authorization: Supertext-Auth-Key <key>`. The header name must be `Authorization` (`Authentication` gets 403; no prefix gets 400). Supertext shows the key with the prefix, so strip a pasted `Supertext-Auth-Key ` and always send exactly one.
- **Rate limit:** the API limits requests per second per key (HTTP 429, `RATE_LIMIT_EXCEEDED`). Translating into several languages at once hits it. Retry a 429 up to 4 times (`Retry-After`, else 1/2/4/8 s with jitter).
- **Rich text:** each element carrying `data-st-id` is translated on its own. Send a whole paragraph (heading, list item) as **one** `data-st-id` element with formatting and links as inline tags (`<b>`, `<i>`, `<a href>`), and map them back to the CMS's rich-text nodes. Never give each formatted run its own `data-st-id`: sentences break at the formatting (lower-case starts, words moved outside the tags).
- **Languages:** only the codes Supertext's `GET features` lists (the SDK's `Languages`, `supertext-sdk/v1`): bare sources (`en`); targets regional only for de/en/fr/it/pt (`de-CH`, `en-US`), `zh-Hans`/`zh-Hant`, `sr-Latn`/`sr-Cyrl`, `gsw-u-sd-chzh`/`chbe`, bare for the rest (`es`, `nl`, `sl`). **Defaults only where obvious:** the plugin's mapping (a combo box per Directus language on the Supertext page, preselected with `Languages.suggestTarget`, stored in `supertext_state`; `SUPERTEXT_LANGUAGE_MAP` overrides it per language), else an exact match, else the SDK default (de→de-DE, en→en-US, fr→fr-FR, it→it-IT, pt→pt-PT, zh→zh-Hans, zh-TW→zh-Hant, sr→sr-Latn, es-ES→es …), else the error `unsupported_language` (nothing sent; en-IE, de-LI, gsw, … need a choice). See `docs/DEVELOPER.md` → *Language codes*.

## This repo

- `npm test` (unit), `npm run typecheck` (vue-tsc; keep TypeScript 5), `npm run test:integration` (real Directus 12 on SQLite with the demo hook). All must pass before committing.
- All Supertext API calls go through the Supertext SDK (`supertext-sdk`), a devDependency from `vendor/supertext-sdk` bundled into `dist/` and wrapped by `src/shared/supertext-client.ts`. Never edit `vendor/`: fix the SDK in `Supertext/Supertext-API-SDK-and-Guide` and run `scripts/vendor-sdk.sh [ref]`. Version reports, the key check result and the ping go through Supertext Plugin Health (`supertext-plugin-health`), bundled the same way from `vendor/supertext-plugin-health` and used by `src/api/reporting.ts`: never edit it, fix it in `Supertext/Commando-Center-Supertext-Translation` (`plugin-health/`) and run `scripts/vendor-plugin-health.sh [tag]`. Every SDK error code needs a `supertext.<code>` message in all four languages.
- UI strings live in `src/i18n/messages.ts` (English, German, French, Italian; Directus has no extension i18n API); add every new string in all four. API errors stay English and carry a `key` for the app.
- Docs screenshots: `npm run docs:screenshots` (`test/docs/screenshots.mjs`); the README's demo movie: `npm run docs:movie` (`test/docs/movie.mjs`, shared kit in `test/docs/movie/`). Both run against a fresh demo and `test/docs/stand-in.mjs`.
- Before pushing a demo change: `test/demo-check.sh` (CI job **demo**: the demo image on PostgreSQL with the stand-in).
- New settings go in `src/api/config.ts` (read them through `readConfig()`: Directus splits env values at commas) **and** the settings table in `docs/INSTALLATION.md`. The language mapping saved on the Supertext page lives in `src/api/settings.ts` (merged over by the environment with `withLanguageSettings()`). Field handling lives in `src/shared/codecs.ts` (`kindForField`); keep "What is translated" in both guides in sync.
- Translation files (*Export for translation* / *Import translation*, the SDK's `TranslationFiles`): `src/api/files.ts` (segments from the same `encode()` as a translation, keys `<field>.<piece>`), routes `/supertext/export` and `/supertext/import`, dialogs in `interface.vue` (imports go into the form, the editor saves). The reference `item:<collection>:<pk>:<field>:<source>:<target>` is in exported files: changing it is a breaking change.
- Rich text must keep the source's block structure (Directus 12's editor shows HTML it would serialize differently as read-only). Never rebuild markup; replace the inner HTML of leaf blocks.
- Translation review (per language: the review service instead of Supertext): checkbox per language on the Supertext page, stored as `review` with the mapping in `supertext_state` (`src/api/settings.ts`); `SUPERTEXT_REVIEW_URL` (default `REVIEW_URL`, empty = off) in `src/api/config.ts`; `SupertextClient.forReview()` in `src/shared/supertext-client.ts`. Key check, reports and translation files never use it.
- `demo/` is the Railway demo (Dockerfile `demo/Dockerfile`, context = repo root). The demo setup hook must stay idempotent and never log passwords. Demo secrets live only in Railway variables.
- The entry names `supertext` (endpoint), `supertext-translate` (interface), `supertext-translate-flow` (operation) and the module id `supertext` (module bar) are stored in users' projects (fields, flows); renaming them is a breaking change.
