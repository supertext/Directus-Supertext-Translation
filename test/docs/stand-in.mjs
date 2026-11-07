#!/usr/bin/env node
/**
 * Docs screenshots only: answers like the Supertext AI file translation API and returns
 * real German, French and Italian for the demo's sample articles (translations.json,
 * keyed by the segment HTML sent). Other text comes back unchanged. Any API key.
 *
 *   node test/docs/stand-in.mjs        # listens on :8765, base URL http://127.0.0.1:8765/v1/
 *
 * STAND_IN_DELAY=<seconds>: files stay `in_progress` that long (the demo movie shows the waiting state).
 */
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const translations = JSON.parse(readFileSync(new URL('translations.json', import.meta.url), 'utf8'));
const files = new Map();
const port = Number(process.env.PORT || 8765);
const delayMs = Number(process.env.STAND_IN_DELAY || 0) * 1000;

http
	.createServer(async (req, res) => {
		const path = new URL(req.url, 'http://x').pathname.replace(/^\/v1/, '');
		const send = (status, body, type = 'application/json') => {
			res.writeHead(status, { 'Content-Type': type });
			res.end(type === 'application/json' ? JSON.stringify(body) : body);
		};
		if (path === '/features') return send(200, {});
		// Stands in for the Commando Center too (SUPERTEXT_REPORT_URL=http://127.0.0.1:8765/report), so screenshots report nothing.
		if (req.method === 'POST' && path === '/report') return send(202, { ok: true });
		if (req.method === 'POST' && path === '/translate/ai/file') {
			const chunks = [];
			for await (const chunk of req) chunks.push(chunk);
			const form = await new Request('http://x', { method: 'POST', headers: req.headers, body: Buffer.concat(chunks) }).formData();
			const target = String(form.get('target_lang'));
			const source = form.get('source_lang');
			// Like the real API: bare targets (`de`) and regional sources (`de-CH`) are rejected.
			if (!target.includes('-') || (typeof source === 'string' && source.includes('-'))) return send(400, { error_code: 'INVALID_LANGUAGE_PAIR' });
			const id = randomBytes(6).toString('hex');
			files.set(id, { html: await form.get('file').text(), target, ready: Date.now() + delayMs });
			return send(200, { file_id: id });
		}
		const match = path.match(/file\/([a-f0-9]+)(\/status|\/translation)?$/);
		const file = match && files.get(match[1]);
		if (!file) return send(404, {});
		if (req.method === 'DELETE') return send(204, '');
		if (match[2] === '/status') return send(200, { status: Date.now() < file.ready ? 'in_progress' : 'done' });
		const dict = translations[file.target] ?? {};
		const html = file.html.replace(/(<div data-st-id="\d+">)([\s\S]*?)(<\/div>)/g, (all, open, inner, close) => (dict[inner] === undefined ? all : open + dict[inner] + close));
		send(200, html, 'text/html');
	})
	.listen(port, () => console.log(`Stand-in API on http://127.0.0.1:${port}/v1/`));
