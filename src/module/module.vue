<template>
	<private-view title="Supertext">
		<template #title-outer:prepend>
			<v-button class="header-icon" rounded disabled icon secondary><v-icon name="translate" /></v-button>
		</template>
		<div class="supertext-module">
			<v-notice v-if="error" type="danger">{{ error }}</v-notice>
			<template v-if="status">
				<h2 class="type-title">{{ t('module.connection') }}</h2>
				<dl>
					<dt>{{ t('module.version') }}</dt>
					<dd>
						<a v-if="releaseUrl(status.version)" :href="releaseUrl(status.version)!" target="_blank" rel="noopener">{{ status.version }}</a>
						<template v-else>{{ status.version || t('module.unknown') }}</template>
					</dd>
					<dt>{{ t('module.apiKey') }}</dt>
					<dd>{{ status.configured ? t('module.keySet') : t('module.keyMissing') }}</dd>
					<dt>{{ t('module.api') }}</dt>
					<dd><code>{{ status.baseUrl }}</code></dd>
					<dt>{{ t('module.reviewService') }}</dt>
					<dd><code v-if="status.reviewUrl">{{ status.reviewUrl }}</code><template v-else>{{ t('module.reviewOff') }}</template></dd>
					<dt>{{ t('module.parallel') }}</dt>
					<dd>{{ status.concurrency }}</dd>
					<dt>{{ t('module.timeout') }}</dt>
					<dd>{{ status.timeoutSeconds }} s</dd>
				</dl>
				<p class="hint key-help">
					{{ t('module.noAccount') }} <a :href="signupUrl" target="_blank" rel="noopener">{{ t('module.createAccount') }}</a>.
					{{ t('module.generateKey') }} <a :href="apiKeyUrl" target="_blank" rel="noopener">{{ t('module.keyPath') }}</a> {{ t('module.adminRole') }}
				</p>
				<dl>
					<dt>{{ t('module.keyCheck') }}</dt>
					<dd>
						<template v-if="check">
							<span :class="check.status === 'ok' ? 'ok' : 'fail'"><v-icon :name="check.status === 'ok' ? 'check' : 'error'" small /> {{ checkText(check) }}</span>
							<div class="hint">{{ t('module.checkedAt', { time: when(check.checkedAt) }) }}</div>
						</template>
						<template v-else>{{ t('module.notChecked') }}</template>
					</dd>
				</dl>
				<div class="test">
					<v-button secondary :loading="testing" @click="test">{{ t('module.test') }}</v-button>
					<span v-if="tested" class="fail"><v-icon name="error" small /> {{ tested }}</span>
				</div>
				<dl>
					<dt>{{ t('module.reports') }}</dt>
					<dd>{{ status.reports?.enabled ? t('module.reportsOn') : t('module.reportsOff') }}</dd>
				</dl>
				<p class="hint">{{ t('module.reportsHelp') }}</p>

				<h2 class="type-title">{{ t('module.languages') }}</h2>
				<p class="hint">{{ t('module.languagesHint') }}</p>
				<p v-if="!status.languages.length" class="hint">{{ t('module.noLanguages') }}</p>
				<template v-else>
					<table class="languages">
						<thead><tr><th>{{ t('module.language') }}</th><th>{{ t('module.supertext') }}</th><th>{{ t('module.tone') }}</th><th>{{ t('module.review') }}</th></tr></thead>
						<tbody>
							<tr v-for="l in status.languages" :key="l.code">
								<td>{{ l.name }} <code>{{ l.code }}</code></td>
								<td>
									<v-select
										v-model="choices[l.code]"
										class="target-select"
										:items="targetItems"
										:placeholder="t('module.choose')"
										:disabled="saving || !!l.override"
										show-deselect
									/>
									<div v-if="l.override" class="hint">{{ t('module.overridden', { code: l.override }) }}</div>
									<div v-else-if="!choices[l.code]" class="fail"><v-icon name="error" small /> {{ t('module.notMapped') }}</div>
									<div v-else-if="!l.saved && choices[l.code] === l.suggested" class="hint">{{ t('module.suggested') }}</div>
								</td>
								<td>
									<template v-if="toneOffered(l)">
										<v-select v-model="tones[l.code]" class="tone-select" :items="toneItems" :disabled="saving || !!l.politenessOverride" />
										<div v-if="l.politenessOverride" class="hint">{{ t('module.toneOverridden') }}</div>
									</template>
									<span v-else class="hint">{{ t('module.noPoliteness') }}</span>
								</td>
								<td>
									<v-checkbox v-model="reviews[l.code]" class="review-checkbox" :label="t('module.reviewOn')" :disabled="saving || !status.reviewUrl" />
								</td>
							</tr>
						</tbody>
					</table>
					<p class="hint">{{ t('module.reviewHint') }}</p>
					<div class="test">
						<v-button :loading="saving" @click="saveLanguages">{{ t('module.save') }}</v-button>
						<span v-if="saved" class="ok"><v-icon name="check" small /> {{ t('module.saved') }}</span>
						<span v-if="saveError" class="fail"><v-icon name="error" small /> {{ saveError }}</span>
					</div>
				</template>
			</template>
			<v-progress-circular v-else-if="!error" indeterminate />
		</div>
	</private-view>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useApi } from '@directus/extensions-sdk';
import { apiErrorText, currentLanguage, t, type MessageKey } from '../i18n/index.js';

const signupUrl = 'https://www.supertext.com/person/en/account/signin';
const apiKeyUrl = 'https://www.supertext.com/en/integrations/api';
/** GitHub release page for a release version (X.Y.Z). */
const releaseUrl = (v: unknown) => (typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v) ? `https://github.com/Supertext/Directus-Supertext-Translation/releases/tag/v${v}` : null);

const api = useApi();
const status = ref<any>(null);
const error = ref('');
const testing = ref(false);
const tested = ref<string | null>(null);
type KeyCheck = { status: 'ok' | 'invalid' | 'missing' | 'unreachable' | 'error'; checkedAt: string; httpStatus: number | null };
const check = ref<KeyCheck | null>(null);

/** The key check result in the user's language (texts from the Commando Center's guide). */
const checkText = (c: KeyCheck) => t(`keycheck.${c.status}` as MessageKey, { status: c.httpStatus ?? '' });
const when = (iso: string) => {
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(currentLanguage());
};

type Target = { code: string; name: string; politeness: boolean };
type Language = {
	code: string;
	name: string;
	target: string | null;
	saved: string | null;
	override: string | null;
	suggested: string | null;
	politeness: 'default' | 'more' | 'less';
	savedPoliteness: 'default' | 'more' | 'less';
	politenessOverride: string | null;
	review: boolean;
};

/** The chosen Supertext code per Directus language: saved, else the suggestion (exact match or SDK default), else none. */
const choices = reactive<Record<string, string | null>>({});
const tones = reactive<Record<string, string>>({});
/** *Translation review* per Directus language (off by default). */
const reviews = reactive<Record<string, boolean>>({});
const saving = ref(false);
const saved = ref(false);
const saveError = ref('');

/** A Supertext code's name in the user's language (Intl), else the SDK's English name. */
function displayName(target: Target): string {
	if (target.code.includes('-u-')) return target.name; // Swiss German dialects: Intl only knows "Swiss German"
	try {
		const name = new Intl.DisplayNames([currentLanguage()], { type: 'language' }).of(target.code);
		return name && name !== target.code ? name : target.name;
	} catch {
		return target.name;
	}
}

const targetItems = computed(() =>
	((status.value?.targets ?? []) as Target[])
		.map((target) => ({ text: `${displayName(target)} (${target.code})`, value: target.code }))
		.sort((a, b) => a.text.localeCompare(b.text, currentLanguage())),
);
const toneItems = computed(() => [
	{ text: t('module.default'), value: 'default' },
	{ text: t('module.formal'), value: 'more' },
	{ text: t('module.informal'), value: 'less' },
]);

/** Formal/informal only where the target that will be sent offers it. */
function toneOffered(l: Language): boolean {
	const code = l.override ?? choices[l.code];
	const target = ((status.value?.targets ?? []) as Target[]).find((x) => x.code === code);
	return target?.politeness === true;
}

async function load() {
	status.value = (await api.get('/supertext/status')).data.data;
	check.value = status.value?.reports?.check ?? null;
	for (const l of status.value.languages as Language[]) {
		choices[l.code] = l.saved ?? l.suggested ?? null;
		tones[l.code] = l.politeness;
		reviews[l.code] = l.review === true;
	}
}

onMounted(async () => {
	try {
		await load();
	} catch (e: any) {
		error.value = apiErrorText(e);
	}
});

async function saveLanguages() {
	saving.value = true;
	saved.value = false;
	saveError.value = '';
	try {
		const languages = (status.value.languages as Language[]).map((l) => ({
			language: l.code,
			target: l.override ? l.saved : (choices[l.code] ?? null),
			politeness: l.politenessOverride ? l.savedPoliteness : (tones[l.code] ?? 'default'),
			review: reviews[l.code] === true,
		}));
		await api.post('/supertext/languages', { languages });
		await load();
		saved.value = true;
	} catch (e: any) {
		saveError.value = apiErrorText(e);
	} finally {
		saving.value = false;
	}
}

async function test() {
	testing.value = true;
	tested.value = null;
	try {
		check.value = (await api.post('/supertext/test')).data.data.check;
	} catch (e: any) {
		tested.value = apiErrorText(e);
	} finally {
		testing.value = false;
	}
}
</script>

<style scoped>
.supertext-module { padding: 0 var(--content-padding) var(--content-padding-bottom); max-width: 960px; display: grid; gap: 16px; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 8px 24px; margin: 0; }
dt { font-weight: 600; }
dd { margin: 0; }
.test { display: flex; align-items: center; gap: 12px; }
.ok { color: var(--theme--success); }
.fail { color: var(--theme--danger); }
.hint { color: var(--theme--foreground-subdued); margin: 0; }
.hint a, dd a { color: var(--theme--primary); }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--theme--border-color-subdued); }
th { color: var(--theme--foreground-subdued); font-weight: 600; }
h2 { margin-top: 12px; }
.languages { table-layout: fixed; }
.languages td { vertical-align: top; overflow-wrap: anywhere; }
.languages td .hint, .languages td .fail { margin-top: 4px; font-size: 0.9em; }
.languages td:first-child code { display: block; }
.languages th:nth-child(1) { width: 22%; }
.languages th:nth-child(2) { width: 40%; }
.languages th:nth-child(3) { width: 22%; }
.languages th:nth-child(4) { width: 16%; }
.languages .target-select, .languages .tone-select { width: 100%; }
</style>
