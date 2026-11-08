# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Support for Directus 12.6 and Node.js 24 and 26: tested in CI on Node 22, 24 and 26, with the integration tests on Directus 12.6.0 (which needs Node.js 26); the demo runs Directus 12.6.0. Directus extensions SDK 18.1.
- **Translation review** on/off per language on the Supertext page (module bar → Supertext → *Languages*, checkbox *Translation review*, then *Save languages*): translations into a language with it ticked go through Supertext's review service (Supertext Localization Review), where customers and Supertext linguists correct them on the website with a Chrome extension; corrections come back into Directus with the next translation, and texts translated before keep their (reviewed) wording. Same API key, billing, languages and messages; other languages keep going directly to Supertext. Applies to the translate box and the Flow operation. New setting `SUPERTEXT_REVIEW_URL` (defaults to Supertext's review service; empty turns review off for every language), shown on the Supertext page as *Review service*. Stored with the language mapping in `supertext_state`; existing installations start with review off. All four interface languages.
- Requests to Supertext name the extension's version in the User-Agent (`Directus-Supertext-Translation/<version>`).

- Export for translation (XLIFF 1.2 or HTML) and import of translated files; Supertext SDK 0.5.0. *Export for translation* and *Import translation* in the *Translate with Supertext* box: download the item's text for one or more languages, have it translated in a translation tool, by a translator or in Supertext's web app, and import the file into the form (summary: imported, skipped because the source changed, untranslated, formatting changed, not in the file), then save.

- **Language mapping on the Supertext page:** one combo box per Directus language (Directus's own select) with Supertext's languages as *Name (code)*, names in the user's interface language, plus a *Tone* box where Supertext offers formal/informal. *Save languages* stores the choices in the Directus database (`supertext_state`), applies them without a restart and checks every code server-side. Each box preselects the saved code, else the suggestion (the same code, else the obvious default), else *— choose —*. `SUPERTEXT_LANGUAGE_MAP` and `SUPERTEXT_POLITENESS` stay as overrides for automated setups: an entry there wins for its language and the page shows it as *Set by SUPERTEXT_LANGUAGE_MAP*. Existing environment mappings keep working unchanged. New strings in English, German, French and Italian.

- Automatic API key check: when the key in `SUPERTEXT_API_KEY` is new or changed, on *Test connection* and when Supertext rejects the key during a translation. The Supertext page shows the latest result with its time (*the connection works*, *rejected*, *no key*, *Supertext can't be reached*, *error*) in English, German, French and Italian.
- *Send version information to Supertext* (on by default, `SUPERTEXT_VERSION_REPORTS=0` turns it off): after an update and when the key check result changes, the extension sends the site URL, the extension, Directus, Node.js and SDK versions, whether a key is set, the key check result and the ping address to Supertext. No content, no API key and no personal data. Shown on the Supertext page.
- Public ping endpoint `/supertext/ping` that only echoes Supertext's challenge, so Supertext can check the site is reachable (404 with version reports off).
- The extension stores this state in a new table `supertext_state` (created automatically).
- Support: the Supertext support form is linked in the README, the user guide and GitHub's "New issue" page.

### Changed

- Tested with Directus 12.6.1: the demo and the integration tests moved from Directus 12.6.0 to 12.6.1.
- Docs: demo movie in the README (`docs/images/demo.gif`, recorded from the demo against the stand-in with `npm run docs:movie`; the MP4 version, not committed, is narrated with the Piper voice “alba”).

- Bundled Supertext SDK 0.4.0 (commit `6aaad33`): **a language nobody mapped uses its obvious default** instead of failing: `de` → `de-DE`, `en` → `en-US`, `fr` → `fr-FR`, `it` → `it-IT`, `pt` → `pt-PT`, `zh`/`zh-CN` → `zh-Hans`, `zh-TW`/`zh-HK` → `zh-Hant`, `sr` → `sr-Latn`, `es-ES` → `es`. Languages without an obvious default (`en-IE`, `de-LI`, `gsw`, `sr-RS`, …) still need a choice; only those are flagged on the Supertext page (*No default*), and the message *has no Supertext language yet* now says where to choose one.
- Version reports, the API key check result and the reachability ping now use [Supertext Plugin Health](https://github.com/Supertext/Commando-Center-Supertext-Translation/tree/main/plugin-health) 0.1.0 (bundled from `vendor/supertext-plugin-health`); Supertext SDK updated to 0.3.0. No change for sites: settings and stored state stay as they are.
- **Languages are no longer guessed.** A Directus language code that is a Supertext code (`de-CH`, `fr-CH`, `es`, `zh-Hans`, apart from case and `_`/`-`) is used as it is; every other code needs an entry in `SUPERTEXT_LANGUAGE_MAP`. The default regions are gone: they were wrong for most languages (Supertext wants `es`, `sl`, `nl` without region, `zh-Hans` instead of `zh-CN`). An unmapped language gets the message *has no Supertext language yet* (four languages) and nothing is sent for it; the Supertext page marks it *Not mapped* and warns about a tone Supertext doesn't offer for a language. New message for *no formal/informal tone for this language*.
- Bundled Supertext SDK 0.2.0 (commit `c66cb4d`): the key check, the version reports and the API's language list (`v1` namespace).
- `POST /supertext/test` returns the key check (`{ ok, check }`) instead of an error for a rejected key.

### Fixed

- Bundled Supertext SDK 0.2.1 (commit `eeba8fa`): one `SUPERTEXT_LANGUAGE_MAP` serves both directions. A mapped language is sent as a source in its source form (`{"de":"de-CH"}` translates from `de`), so English as the source no longer fails with an `{"en":"en-US"}` mapping.

### Changed

- The connection to Supertext now uses the shared [Supertext SDK](https://github.com/Supertext/Supertext-API-SDK-and-Guide) (TypeScript SDK 0.1.0), bundled into the extension's build, so nothing else needs installing. Translation works as before; an unsupported language pair now has its own message (*Supertext does not support this language pair*) in all four languages. An unknown language (e.g. `xx-YY`) is now reported as an unsupported language pair too, not as "resource not found" (Supertext answers it with HTTP 404).
- Tested with Directus 12.5 (integration tests and the demo moved from 12.4.1 to 12.5.0, which fixes known vulnerabilities in their dependencies).

### Added

- French and Italian interface (and German where it was missing): the translate box, the Supertext page, the Flow operation and their messages follow the user's Directus language (English, German, French, Italian; other languages show English). API errors carry `extensions.key`/`values` (and failed languages `key`/`values`) so the app can show them translated.
- The Supertext page shows the plugin version (from `package.json`), linked to its release on GitHub; `/supertext/status` returns it as `version`.

### Changed

- The *No Supertext API key is configured* message on *Test connection* and the *Authentication failure* message now link to both Supertext account signup and API key generation.

### Fixed


## [0.1.0] - 2026-10-07

### Added

- Directus 12 bundle `directus-extension-supertext-translation`.
- **Supertext** page for administrators (module bar): configuration, the languages with their Supertext code and tone, and *Test connection*; endpoints `/supertext/status` and `/supertext/test`.

- *Supertext translation* interface: a **Translate with Supertext** box in the item form with source and target languages, a warning and confirmation for languages that already have text, and results per language. Translations go into the form's Translations field; the editor reviews and saves.
- Flow operation **Supertext: translate**: translates and saves items from a manual or event trigger; *Only empty languages*; saving doesn't re-trigger flows.
- Endpoint `/supertext/info` and `/supertext/translate`, with the user's permissions; users who can't edit the item are refused before anything is sent.
- Links to create a Supertext account and to generate the API key (supertext.com → Integrations → API, Admin role required) on the Supertext page, in the *Test connection* error without a key, and in the README and installation guide.
- Text, rich text (block by block, formatting and structure kept, editable in Directus 12's editor) and markdown fields.
- Settings via environment variables: `SUPERTEXT_API_KEY` (with or without the `Supertext-Auth-Key` prefix), `SUPERTEXT_ENVIRONMENT`, `SUPERTEXT_API_URL`, `SUPERTEXT_LANGUAGE_MAP`, `SUPERTEXT_POLITENESS`, `SUPERTEXT_CONCURRENCY`, `SUPERTEXT_POLL_INTERVAL`, `SUPERTEXT_TIMEOUT`.
- Retries when Supertext's rate limit is hit (HTTP 429).
- Installation, user and developer guides with screenshots; unit tests and integration tests against a real Directus 12; CI.
- Directus 12 demo (`demo/`) with accounts from `DEMO_ADMIN_*` / `DEMO_EDITOR_*`, an Editor role, four Swiss languages and English sample articles, deployed on Railway.

### Fixed

- JSON settings with more than one entry (e.g. `SUPERTEXT_POLITENESS={"de-CH":"more","fr-CH":"more"}`) were rejected, because Directus splits environment values at commas.
