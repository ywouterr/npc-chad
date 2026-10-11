# Voice Practice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add speech input (Whisper), a session-long mistakes panel (desktop) / inline mistakes (mobile), a shared-password gate and PWA files to Kotoba Chat, ready to deploy on Railway.

**Architecture:** Same zero-dependency Node server plus one static page. Pure logic (reply parsing, password check, Whisper call) moves into `lib/` so it can be unit tested with `node --test`. The browser records audio with `MediaRecorder`, POSTs it to `/api/transcribe`, and auto-sends the returned text to `/api/chat`. The chat reply carries a `corrections` array that feeds both the right-hand panel and inline boxes (one rendering path, CSS decides which is visible).

**Tech Stack:** Node >= 18 (Node 22 installed), ESM, no npm dependencies, `node:test`, browser `MediaRecorder` / service worker, OpenAI `whisper-1`, Anthropic via the OpenAI-compatible endpoint (`claude-sonnet-5-5`).

Spec: `docs/superpowers/specs/2026-10-11-voice-practice-design.md`. One refinement to the spec: the service worker uses stale-while-revalidate for the shell instead of pure cache-first, so deployed updates show up on the next open without bumping a cache version by hand.

## Global Constraints

- No npm dependencies; Node built-ins only (`node:test`, `node:crypto`, global `fetch`/`FormData`/`Blob`).
- Whisper: model `whisper-1`, `language=ja`, `prompt` = target words (max 200 chars).
- Recording: max 60 s auto-stop; clips shorter than 700 ms are rejected client-side; audio upload limit 2 MB.
- At most 3 corrections per turn; reply field is `corrections` (array, `[]` when none).
- Chat `max_tokens` 2000; no `temperature` parameter (Sonnet 5.5 rejects it).
- Password header: `x-app-key`; env var `APP_PASSWORD`; unset means no check; wrong password answered after 1 s with 401.
- Panel breakpoint: 1100 px. Below that, mistakes are inline under the user's message.
- Env var names: `LLM_API_KEY`, `LLM_MODEL`, `LLM_BASE_URL`, `LLM_MOCK`, `OPENAI_API_KEY`, `APP_PASSWORD`, `PORT`.
- Never commit `.env`. `.env.example` holds placeholders only.
- Commit messages end with the line `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` (pass it as a second `-m`).
- Working directory for every command: `C:\Users\Yannick\Documents\Japans\chat-bot\kotoba-chat\kotoba-chat` (Git Bash syntax unless a step says PowerShell).

## File Structure

| File | Responsibility |
|---|---|
| `.gitignore` (new) | keep `.env`, `node_modules` out of git |
| `package.json` | add `test` script |
| `lib/auth.js` (new) | `checkPassword(expected, provided)` |
| `lib/parse-reply.js` (new) | `parseReply(text)` normalises the model's JSON, including `corrections` |
| `lib/transcribe.js` (new) | `transcribe({ audio, contentType, apiKey, prompt, fetchImpl })` calls Whisper |
| `tests/*.test.js` (new) | unit tests for the three lib files |
| `server.js` | use the libs, new prompt, `/api/transcribe`, auth on `/api/*`, config flag, static types |
| `public/index.html` | mistakes panel + layout, inline corrections, `api()` wrapper with password prompt, mic button, PWA tags |
| `public/manifest.webmanifest`, `public/sw.js` (new) | PWA |
| `scripts/make-icons.ps1` (new), `public/icon-192.png`, `public/icon-512.png` (new) | icons |
| `.env.example`, `README.md` | document new env vars and deploy steps |

---

### Task 1: Project repo, `.gitignore`, test script

**Files:**
- Create: `.gitignore`
- Modify: `package.json`

**Interfaces:**
- Produces: a git repo on branch `main` in the project folder; `npm test` runs `node --test`.

- [ ] **Step 1: Create `.gitignore`**

```
.env
node_modules/
.DS_Store
```

- [ ] **Step 2: Add the test script to `package.json`**

Replace the `scripts` block so the file reads:

```json
{
  "name": "kotoba-chat",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Practise Japanese vocabulary through a guided LLM conversation at your JLPT level",
  "scripts": {
    "start": "node server.js",
    "test": "node --test"
  },
  "engines": { "node": ">=18" }
}
```

- [ ] **Step 3: Initialise the repo and make sure no secret will be committed**

Run:
```bash
git init -b main
git check-ignore .env
grep -rnE 'sk-[A-Za-z0-9_-]{20,}' --exclude-dir=.git --exclude=.env .
```
Expected: `git check-ignore` prints `.env`; the `grep` prints nothing.

- [ ] **Step 4: Commit**

```bash
git add .
git status --short
git commit -m "chore: initial commit of Kotoba Chat" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
Expected: `git status --short` lists no `.env`. The user connects GitHub afterwards with `git remote add origin <their-repo-url>` and `git push -u origin main`.

---

### Task 2: Password check (`lib/auth.js`)

**Files:**
- Create: `lib/auth.js`
- Test: `tests/auth.test.js`

**Interfaces:**
- Produces: `checkPassword(expected: string, provided: string | undefined): boolean`. Returns `true` when `expected` is empty (auth disabled).

- [ ] **Step 1: Write the failing test** (`tests/auth.test.js`)

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPassword } from '../lib/auth.js';

test('allows everything when no password is configured', () => {
  assert.equal(checkPassword('', undefined), true);
  assert.equal(checkPassword('', 'anything'), true);
});

test('accepts the correct password', () => {
  assert.equal(checkPassword('s3cret', 's3cret'), true);
});

test('rejects wrong, empty and missing passwords', () => {
  assert.equal(checkPassword('s3cret', 'nope'), false);
  assert.equal(checkPassword('s3cret', ''), false);
  assert.equal(checkPassword('s3cret', undefined), false);
});

test('rejects a password that is only a prefix or longer', () => {
  assert.equal(checkPassword('s3cret', 's3cre'), false);
  assert.equal(checkPassword('s3cret', 's3cret!'), false);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npm test`
Expected: FAIL, `Cannot find module '../lib/auth.js'`.

- [ ] **Step 3: Implement** (`lib/auth.js`)

```js
import { createHash, timingSafeEqual } from 'node:crypto';

// Hash both sides so timingSafeEqual always compares equal-length buffers.
export function checkPassword(expected, provided) {
  if (!expected) return true;
  if (typeof provided !== 'string' || !provided) return false;
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(provided).digest();
  return timingSafeEqual(a, b);
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `npm test`
Expected: 4 passing tests, 0 failing.

- [ ] **Step 5: Commit**

```bash
git add lib/auth.js tests/auth.test.js
git commit -m "feat: add shared-password check" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Reply parsing with `corrections` (`lib/parse-reply.js`)

**Files:**
- Create: `lib/parse-reply.js`
- Test: `tests/parse-reply.test.js`

**Interfaces:**
- Produces: `parseReply(text: string): { corrections: {original: string, corrected: string, explanation: string}[], japanese: string, english: string, used_words: string[], hint: string, finished: boolean }`. Throws `Error('No JSON in model reply')` or `Error('Reply missing "japanese"')`.

- [ ] **Step 1: Write the failing test** (`tests/parse-reply.test.js`)

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReply } from '../lib/parse-reply.js';

const base = { japanese: '{今日|きょう}は{晴|は}れですね。', english: 'Sunny today.', used_words: ['天気'], hint: 'Try 傘', finished: false };
const wrap = (o) => 'Here you go:\n' + JSON.stringify({ ...base, ...o });

test('parses a reply without corrections', () => {
  const r = parseReply(wrap({ corrections: [] }));
  assert.deepEqual(r.corrections, []);
  assert.equal(r.japanese, base.japanese);
  assert.deepEqual(r.used_words, ['天気']);
  assert.equal(r.finished, false);
});

test('keeps a corrections array and fills missing fields', () => {
  const r = parseReply(wrap({ corrections: [{ original: '私は学校を行きます', corrected: '私は学校に行きます', explanation: 'Use に for destination.' }, { corrected: 'ありがとうございます' }] }));
  assert.equal(r.corrections.length, 2);
  assert.deepEqual(r.corrections[1], { original: '', corrected: 'ありがとうございます', explanation: '' });
});

test('wraps the old single "correction" object', () => {
  const r = parseReply(wrap({ correction: { original: 'a', corrected: 'b', explanation: 'c' } }));
  assert.deepEqual(r.corrections, [{ original: 'a', corrected: 'b', explanation: 'c' }]);
});

test('drops entries without a corrected string and caps the list at 3', () => {
  const many = Array.from({ length: 5 }, (_, i) => ({ original: 'o' + i, corrected: 'c' + i, explanation: 'e' }));
  const r = parseReply(wrap({ corrections: [null, { original: 'x' }, { corrected: '   ' }, ...many] }));
  assert.equal(r.corrections.length, 3);
  assert.deepEqual(r.corrections.map((c) => c.corrected), ['c0', 'c1', 'c2']);
});

test('treats null or missing corrections as none', () => {
  assert.deepEqual(parseReply(wrap({ corrections: null })).corrections, []);
  assert.deepEqual(parseReply(wrap({})).corrections, []);
});

test('throws on text without JSON and on JSON without "japanese"', () => {
  assert.throws(() => parseReply('sorry, no json'), /No JSON/);
  assert.throws(() => parseReply('{"english":"x"}'), /missing "japanese"/);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npm test`
Expected: FAIL, `Cannot find module '../lib/parse-reply.js'`.

- [ ] **Step 3: Implement** (`lib/parse-reply.js`)

```js
const MAX_CORRECTIONS = 3;

function normaliseCorrections(r) {
  const raw = Array.isArray(r.corrections) ? r.corrections : r.correction ? [r.correction] : [];
  return raw
    .filter((c) => c && typeof c.corrected === 'string' && c.corrected.trim())
    .slice(0, MAX_CORRECTIONS)
    .map((c) => ({
      original: String(c.original || ''),
      corrected: c.corrected,
      explanation: String(c.explanation || ''),
    }));
}

export function parseReply(text) {
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s < 0 || e < s) throw new Error('No JSON in model reply');
  const r = JSON.parse(text.slice(s, e + 1));
  if (typeof r.japanese !== 'string') throw new Error('Reply missing "japanese"');
  return {
    corrections: normaliseCorrections(r),
    japanese: r.japanese,
    english: String(r.english || ''),
    used_words: Array.isArray(r.used_words) ? r.used_words.map(String) : [],
    hint: String(r.hint || ''),
    finished: !!r.finished,
  };
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `npm test`
Expected: all tests in `auth.test.js` and `parse-reply.test.js` pass.

- [ ] **Step 5: Commit**

```bash
git add lib/parse-reply.js tests/parse-reply.test.js
git commit -m "feat: parse multiple corrections from model replies" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Whisper client (`lib/transcribe.js`)

**Files:**
- Create: `lib/transcribe.js`
- Test: `tests/transcribe.test.js`

**Interfaces:**
- Produces: `transcribe({ audio: Buffer, contentType: string, apiKey: string, prompt?: string, fetchImpl?: typeof fetch }): Promise<string>`. Returns trimmed text (possibly `''`). On a non-2xx response throws `Error('Whisper error <status>: <body up to 300 chars>')` with `err.status = 502`.

- [ ] **Step 1: Write the failing test** (`tests/transcribe.test.js`)

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { transcribe } from '../lib/transcribe.js';

test('posts audio to Whisper as Japanese and returns trimmed text', async () => {
  let seen;
  const fakeFetch = async (url, opts) => {
    seen = { url, opts };
    return { ok: true, json: async () => ({ text: '  こんにちは。 ' }) };
  };
  const text = await transcribe({
    audio: Buffer.from([1, 2, 3]),
    contentType: 'audio/webm;codecs=opus',
    apiKey: 'sk-test',
    prompt: '天気、傘',
    fetchImpl: fakeFetch,
  });
  assert.equal(text, 'こんにちは。');
  assert.equal(seen.url, 'https://api.openai.com/v1/audio/transcriptions');
  assert.equal(seen.opts.method, 'POST');
  assert.equal(seen.opts.headers.Authorization, 'Bearer sk-test');
  const form = seen.opts.body;
  assert.equal(form.get('model'), 'whisper-1');
  assert.equal(form.get('language'), 'ja');
  assert.equal(form.get('prompt'), '天気、傘');
  assert.equal(form.get('file').name, 'speech.webm');
});

test('uses an mp4 file name for mp4 audio and omits an empty prompt', async () => {
  let form;
  const fakeFetch = async (_url, opts) => { form = opts.body; return { ok: true, json: async () => ({ text: 'はい' }) }; };
  await transcribe({ audio: Buffer.from([1]), contentType: 'audio/mp4', apiKey: 'k', fetchImpl: fakeFetch });
  assert.equal(form.get('file').name, 'speech.mp4');
  assert.equal(form.get('prompt'), null);
});

test('returns an empty string when Whisper returns no text', async () => {
  const fakeFetch = async () => ({ ok: true, json: async () => ({}) });
  assert.equal(await transcribe({ audio: Buffer.from([1]), contentType: 'audio/webm', apiKey: 'k', fetchImpl: fakeFetch }), '');
});

test('throws a 502 error with the upstream status on failure', async () => {
  const fakeFetch = async () => ({ ok: false, status: 401, text: async () => 'bad key' });
  await assert.rejects(
    transcribe({ audio: Buffer.from([1]), contentType: 'audio/webm', apiKey: 'k', fetchImpl: fakeFetch }),
    (err) => /Whisper error 401: bad key/.test(err.message) && err.status === 502,
  );
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npm test`
Expected: FAIL, `Cannot find module '../lib/transcribe.js'`.

- [ ] **Step 3: Implement** (`lib/transcribe.js`)

```js
const ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';

function extensionFor(contentType) {
  if (contentType.includes('mp4')) return 'mp4';
  if (contentType.includes('ogg')) return 'ogg';
  return 'webm';
}

export async function transcribe({ audio, contentType, apiKey, prompt = '', fetchImpl = fetch }) {
  const form = new FormData();
  form.append('file', new Blob([audio], { type: contentType }), `speech.${extensionFor(contentType)}`);
  form.append('model', 'whisper-1');
  form.append('language', 'ja');
  if (prompt) form.append('prompt', prompt);

  const res = await fetchImpl(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw Object.assign(new Error(`Whisper error ${res.status}: ${body}`), { status: 502 });
  }
  const data = await res.json();
  return String(data.text || '').trim();
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `npm test`
Expected: all tests pass (auth, parse-reply, transcribe).

- [ ] **Step 5: Commit**

```bash
git add lib/transcribe.js tests/transcribe.test.js
git commit -m "feat: add Whisper transcription client" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Server wiring (`server.js`)

**Files:**
- Modify: `server.js` (replace the whole file with the version below)

**Interfaces:**
- Consumes: `parseReply` (Task 3), `checkPassword` (Task 2), `transcribe` (Task 4).
- Produces (HTTP):
  - `POST /api/chat` body adds optional `source: 'voice' | 'text'`; reply object has `corrections` array.
  - `POST /api/transcribe?words=<text>` raw audio body (`Content-Type` = audio type) returns `{ text: string }`.
  - `GET /api/config` returns `{ model: string, voice: boolean }`.
  - All `/api/*` require header `x-app-key` when `APP_PASSWORD` is set, otherwise 401 `{ error }` after 1 s.

- [ ] **Step 1: Replace `server.js` with this content**

```js
// Kotoba Chat — tiny zero-dependency server (Node 18+)
// Serves the UI and proxies chat turns to any OpenAI-compatible LLM endpoint.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseReply } from './lib/parse-reply.js';
import { checkPassword } from './lib/auth.js';
import { transcribe } from './lib/transcribe.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

// --- minimal .env loader (no dotenv needed) ---
const envPath = join(ROOT, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = (process.env.LLM_BASE_URL || 'https://api.anthropic.com/v1').replace(/\/$/, '');
const API_KEY = process.env.LLM_API_KEY || '';
const MODEL = process.env.LLM_MODEL || 'claude-haiku-4-5-20251001';
const MOCK = process.env.LLM_MOCK === '1';
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const PUBLIC = join(ROOT, 'public');

const LEVELS = ['N5', 'N4', 'N3', 'N2', 'N1'];

function systemPrompt({ words, remaining, level, scenario, voice }) {
  return `You are a warm, patient Japanese conversation partner for a learner at JLPT ${level} level.

TARGET WORDS (the whole list): ${words.join('、')}
NOT YET USED: ${remaining.length ? remaining.join('、') : '(all used — start wrapping up naturally)'}
${scenario ? `SCENARIO: ${scenario}` : 'SCENARIO: choose a natural everyday situation in which the target words fit well.'}

YOUR JOB
- Lead a natural, guided conversation (roughly 8–15 exchanges) in which EVERY target word occurs.
- Weave in 1–2 not-yet-used target words per turn, and ask questions that invite the learner to use target words themselves.
- Apart from the target words, keep grammar and vocabulary at or below ${level}. Short sentences: 1–3 per turn, usually ending with a question.
- If the learner's last message has mistakes, list EVERY genuine mistake (grammar, particles, conjugation, word choice) in "corrections", at most 3, most important first. If it was fine, "corrections" is []. Never correct the "(start)" message.
${voice ? '- The learner\'s last message came from speech recognition. Ignore punctuation, spacing, kanji-versus-kana choices and obvious mishearings; only report genuine mistakes the learner made.\n' : ''}- If the learner writes in English or says they don't know, help them with a simple model answer and keep going.
- When all target words have been used, wrap up the conversation kindly and set "finished": true.

OUTPUT — respond with ONLY a JSON object, no markdown fences:
{
  "corrections": [ { "original": "the learner's wrong phrase", "corrected": "the fixed phrase", "explanation": "short English explanation" } ],
  "japanese": "your reply, with furigana on EVERY kanji word in the form {漢字|かんじ}, e.g. {今日|きょう}は{何|なに}を{食|た}べましたか。",
  "english": "natural English translation of your reply",
  "used_words": ["target words (exactly as listed) that occur in your reply or in the learner's last message, including conjugated forms"],
  "hint": "short English hint on how the learner could answer, suggesting a target word to try if relevant",
  "finished": false
}`;
}

async function callLLM(system, messages) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      messages: [{ role: 'system', content: system }, ...messages],
    }),
  });
  if (!res.ok) throw new Error(`LLM error ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const data = await res.json();
  return { text: data.choices?.[0]?.message?.content ?? '', usage: data.usage || null };
}

function mockReply({ remaining, messages }) {
  const w = remaining.slice(0, 2);
  const turn = messages.filter((m) => m.role === 'assistant').length;
  const last = messages[messages.length - 1];
  const mockMistake = turn > 0 && last?.role === 'user'
    ? [{ original: last.content, corrected: '（モック）' + last.content, explanation: 'Mock correction — shows how a mistake is displayed.' }]
    : [];
  return {
    corrections: mockMistake,
    japanese: w.length
      ? `（モック ${turn + 1}）「${w.join('」と「')}」を{使|つか}ってみましょう。どう{思|おも}いますか。`
      : 'ぜんぶ{使|つか}いましたね！おつかれさまでした。',
    english: w.length ? `(mock) Let's try using "${w.join('" and "')}". What do you think?` : 'You used them all! Well done.',
    used_words: w,
    hint: 'This is mock mode — set LLM_API_KEY in .env for real conversations.',
    finished: w.length === 0,
  };
}

async function handleChat(body) {
  const words = (Array.isArray(body.words) ? body.words : []).map((w) => String(w).trim()).filter(Boolean).slice(0, 40);
  const remaining = (Array.isArray(body.remaining) ? body.remaining : words).map(String).filter((w) => words.includes(w));
  const level = LEVELS.includes(body.level) ? body.level : 'N4';
  const scenario = String(body.scenario || '').slice(0, 300);
  const voice = body.source === 'voice';
  let messages = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-60)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
  if (!words.length) throw Object.assign(new Error('Give at least one word'), { status: 400 });
  if (!messages.length) messages = [{ role: 'user', content: '(start) The learner is ready — please open the conversation.' }];

  if (MOCK) return { reply: mockReply({ remaining, messages }), usage: null };
  if (!API_KEY) throw Object.assign(new Error('LLM_API_KEY is not set (see .env.example), or run with LLM_MOCK=1'), { status: 500 });

  const system = systemPrompt({ words, remaining, level, scenario, voice });
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const { text, usage } = await callLLM(system, messages);
    try {
      return { reply: parseReply(text), usage };
    } catch (err) {
      lastErr = err; // retry once on malformed JSON
    }
  }
  throw lastErr;
}

async function handleTranscribe(audio, contentType, words) {
  if (!audio.length) throw Object.assign(new Error('No audio received'), { status: 400 });
  if (MOCK) return { text: 'これはテストです。' };
  if (!OPENAI_KEY) throw Object.assign(new Error('OPENAI_API_KEY is not set (needed for voice input)'), { status: 500 });
  const text = await transcribe({ audio, contentType, apiKey: OPENAI_KEY, prompt: words.slice(0, 200) });
  return { text };
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Request too large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function requireAuth(req) {
  if (checkPassword(APP_PASSWORD, req.headers['x-app-key'])) return;
  await new Promise((resolve) => setTimeout(resolve, 1000)); // slow down guessing
  throw Object.assign(new Error('Wrong or missing password'), { status: 401 });
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) await requireAuth(req);

    if (req.method === 'POST' && url.pathname === '/api/chat') {
      const raw = (await readBody(req, 500_000)).toString('utf8');
      const out = await handleChat(JSON.parse(raw || '{}'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(out));
    }
    if (req.method === 'POST' && url.pathname === '/api/transcribe') {
      const audio = await readBody(req, 2_000_000);
      const out = await handleTranscribe(audio, req.headers['content-type'] || 'audio/webm', url.searchParams.get('words') || '');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(out));
    }
    if (req.method === 'GET' && url.pathname === '/api/config') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ model: MOCK ? 'mock' : MODEL, voice: MOCK || !!OPENAI_KEY }));
    }
    if (req.method === 'GET') {
      const urlPath = decodeURIComponent(url.pathname);
      const file = normalize(join(PUBLIC, urlPath === '/' ? 'index.html' : urlPath));
      if (!file.startsWith(PUBLIC)) throw Object.assign(new Error('Forbidden'), { status: 403 });
      const data = await readFile(file).catch(() => null);
      if (!data) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
      return res.end(data);
    }
    res.writeHead(405); res.end();
  } catch (err) {
    console.error(err.message);
    res.writeHead(err.status || 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, () => {
  console.log(`Kotoba Chat on http://localhost:${PORT}  (model: ${MOCK ? 'MOCK' : MODEL} via ${BASE_URL})`);
});
```

- [ ] **Step 2: Run the unit tests (nothing should have broken)**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 3: Smoke-test the server in mock mode with a password**

Run in one terminal (PowerShell): `$env:LLM_MOCK='1'; $env:APP_PASSWORD='pw'; $env:PORT='3055'; node server.js`
Expected output: `Kotoba Chat on http://localhost:3055  (model: MOCK via https://api.anthropic.com/v1)`

Then in Git Bash:
```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3055/api/config
curl -s -H "x-app-key: pw" http://localhost:3055/api/config
printf 'abc' | curl -s -H "x-app-key: pw" -H "Content-Type: audio/webm" --data-binary @- "http://localhost:3055/api/transcribe?words=%E5%82%98"
curl -s -H "x-app-key: pw" -H "Content-Type: application/json" -d '{"words":["傘"],"messages":[{"role":"user","content":"こんにちは"},{"role":"assistant","content":"x"},{"role":"user","content":"私は学校を行きます"}],"source":"voice"}' http://localhost:3055/api/chat
```
Expected, in order: `401`; `{"model":"mock","voice":true}`; `{"text":"これはテストです。"}`; a JSON object whose `reply.corrections` has one entry with `corrected` starting `（モック）`. Stop the server with Ctrl+C.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: add transcribe endpoint, password gate and multi-correction prompt" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Mistakes panel, inline corrections and `api()` wrapper (`public/index.html`)

**Files:**
- Modify: `public/index.html`

**Interfaces:**
- Consumes: `/api/chat` reply with `corrections` (Task 5); `x-app-key` header.
- Produces (client globals used by Task 7): `api(path, init) -> Promise<Response>` (adds `x-app-key`, prompts for a password on 401), `sendUser(text, source)`, `state.voice`, `state.transcribing`, `state.turn`, `state.lastSource`, `updateMic()` (stub here, filled in Task 7), `loadConfig()`.

- [ ] **Step 1: Add CSS for the panel, inline boxes and the 3-column layout**

In the `<style>` block, insert this immediately **before** the existing `@media (max-width: 800px)` rule (around line 68):

```css
  #mistakes { display: none; border-right: 0; border-left: 1px solid var(--line); }
  #mistakes h2 { margin: 0; font-size: 16px; }
  #mistakes h2 span { color: var(--accent); }
  .mempty { color: var(--muted); font-size: 14px; }
  .corr .tag { float: right; font-size: 11px; opacity: .7; }
  .corr .why { display: block; margin-top: 2px; }
  .inline-corr { margin-top: 6px; text-align: left; }
  @media (min-width: 1100px) {
    .app { grid-template-columns: 320px 1fr 320px; }
    #mistakes { display: flex; }
    .inline-corr { display: none; }
  }
```

- [ ] **Step 2: Add the panel to the markup**

Immediately after the closing `</main>` tag (line ~107), insert:

```html
  <aside id="mistakes">
    <h2>Mistakes <span id="mcount">0</span></h2>
    <div id="mlist"><div class="mempty">No mistakes yet</div></div>
  </aside>
```

- [ ] **Step 3: Update client state and add the `api()` wrapper and `loadConfig()`**

Replace the `const state = {...}` line (line 113) with:

```js
const state = {
  words: [], level: 'N4', scenario: '', messages: [], used: new Set(), tokens: 0, busy: false, finished: false,
  mistakes: [], turn: 0, lastSource: 'text', lastUserEl: null, voice: false, transcribing: false, configLoaded: false,
};
```

Replace the existing `fetch('/api/config')...` line (line 149) with:

```js
// shared password (only needed when the server has APP_PASSWORD set)
let appKey = '';
try { appKey = localStorage.getItem('kotoba-key') || ''; } catch {}
async function api(path, init = {}) {
  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(path, { ...init, headers: { ...(init.headers || {}), 'x-app-key': appKey } });
    if (res.status !== 401) return res;
    const pw = prompt('Password for Kotoba Chat:');
    if (pw === null) return res;
    appKey = pw;
    try { localStorage.setItem('kotoba-key', pw); } catch {}
  }
  return res;
}

function loadConfig() {
  return api('/api/config').then((r) => r.json()).then((c) => {
    if (!c.model) return; // not authorised yet
    state.model = c.model; state.voice = !!c.voice; state.configLoaded = true;
    updateFoot(); updateMic();
  }).catch(() => {});
}
loadConfig();
```

- [ ] **Step 4: Add the correction helpers** (put them right after the `markUsed` function)

```js
function corrHtml(c, tag = '') {
  return `<div class="corr">${tag ? `<span class="tag">${esc(tag)}</span>` : ''}` +
    `${c.original ? `<s>${esc(c.original)}</s> → ` : ''}<b>${esc(c.corrected)}</b>` +
    `${c.explanation ? `<span class="why">${esc(c.explanation)}</span>` : ''}</div>`;
}

function renderMistakes() {
  $('mcount').textContent = state.mistakes.length;
  $('mlist').innerHTML = state.mistakes.length
    ? [...state.mistakes].reverse().map((m) => corrHtml(m, `turn ${m.turn}`)).join('')
    : '<div class="mempty">No mistakes yet</div>';
}

function addMistakes(list, userEl) {
  for (const c of list) state.mistakes.push({ turn: state.turn, ...c });
  if (userEl) {
    const box = div('inline-corr');
    box.innerHTML = list.map((c) => corrHtml(c)).join('');
    userEl.appendChild(box);
  }
  renderMistakes();
}

function updateMic() {} // replaced in the voice-input task
```

- [ ] **Step 5: Make `renderUser` return its element and remove the old correction block from `renderBot`**

Replace `renderUser` with:

```js
function renderUser(text) {
  const m = div('msg me');
  m.innerHTML = `<div class="bubble jp" lang="ja">${esc(text)}</div>`;
  add(m);
  return m;
}
```

In `renderBot`, delete the whole `if (r.correction) { ... }` block (the 5 lines that build the `.corr` html above the bubble) so `html` starts directly with `html += \`<div class="bubble">…`. Change `let html = '';` stays as is.

- [ ] **Step 6: Update `setBusy`, `turn`, `start` and the composer to use `api()`, `sendUser` and the corrections**

Replace `setBusy` with:

```js
function setBusy(b) {
  state.busy = b;
  $('input').disabled = b || !state.words.length;
  $('send').disabled = b || !state.words.length;
  $('start').disabled = b;
  updateMic();
  // don't pop the on-screen keyboard on phones, voice is the main input there
  if (!b && !matchMedia('(pointer: coarse)').matches) $('input').focus();
}
```

In `turn()`, replace the `fetch('/api/chat', {...})` call with:

```js
    const res = await api('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ words: state.words, remaining: remaining(), level: state.level, scenario: state.scenario, messages: state.messages, source: state.lastSource }),
    });
```

and, in `turn()`, right after the line `markUsed(r.used_words, plain(r.japanese), lastUser);` add:

```js
    if (r.corrections.length) addMistakes(r.corrections, state.lastUserEl);
```

Replace the `$('start').onclick` and `$('composer').onsubmit` handlers (the last two blocks before `</script>`) with:

```js
$('start').onclick = () => {
  const words = parseWords($('words').value);
  if (!words.length) { $('words').focus(); return; }
  Object.assign(state, { words, scenario: $('scenario').value.trim(), messages: [], used: new Set(), finished: false, mistakes: [], turn: 0, lastSource: 'text', lastUserEl: null });
  persist();
  $('log').innerHTML = '';
  renderChips();
  renderMistakes();
  if (!state.configLoaded) loadConfig();
  turn();
};

function sendUser(text, source) {
  state.turn += 1;
  state.lastSource = source;
  state.messages.push({ role: 'user', content: text });
  state.lastUserEl = renderUser(text);
  turn();
}

$('composer').onsubmit = (e) => {
  e.preventDefault();
  const text = $('input').value.trim();
  if (!text || state.busy) return;
  $('input').value = '';
  sendUser(text, 'text');
};
```

- [ ] **Step 7: Verify manually in mock mode**

Run (PowerShell): `$env:LLM_MOCK='1'; $env:PORT='3055'; node server.js`, open http://localhost:3055.
Expected:
1. Add the word `傘`, press Start: a mock bot message appears, the panel (browser window wider than 1100 px) shows "No mistakes yet".
2. Type `私は学校を行きます` and Send: a yellow correction box appears in the right panel with `turn 1` and the `（モック）` text; no box shows in the chat.
3. Narrow the window below 1100 px: the panel disappears and the same correction shows under your message bubble in the chat.
4. Press Start again: the panel resets to "No mistakes yet".
5. Reload with `$env:APP_PASSWORD='pw'` set: a password prompt appears; entering `pw` loads the app; a wrong password re-prompts.

- [ ] **Step 8: Commit**

```bash
git add public/index.html
git commit -m "feat: add mistakes panel, inline corrections and password prompt" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Microphone recording, transcription and auto-send (`public/index.html`)

**Files:**
- Modify: `public/index.html`

**Interfaces:**
- Consumes: `api()`, `sendUser(text, source)`, `state.voice`, `state.busy`, `state.transcribing`, `state.words` (Task 6); `POST /api/transcribe` (Task 5).
- Produces: a working `updateMic()` and the mic button.

- [ ] **Step 1: Add mic CSS** (inside `<style>`, next to the other composer rules, before the 1100px media block)

```css
  #mic { font-size: 18px; min-width: 64px; }
  #mic.rec { background: var(--accent); border-color: var(--accent); color: #fff; animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .65; } }
```

- [ ] **Step 2: Add the button to the composer**

In the `<form class="composer">`, between the text `<input>` and the Send button, insert:

```html
      <button type="button" id="mic" hidden aria-label="Record your answer">🎤</button>
```

- [ ] **Step 3: Replace the `updateMic` stub and add the recording code**

Delete the line `function updateMic() {} // replaced in the voice-input task` and add the following block just before `</script>`:

```js
// ---- voice input ----
const MAX_RECORD_S = 60;
const MIN_RECORD_MS = 700;
const MIME = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
  .find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
const rec = { recorder: null, chunks: [], stream: null, timer: null, startedAt: 0 };

function updateMic() {
  const supported = !!(state.voice && navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  $('mic').hidden = !supported;
  const recording = rec.recorder?.state === 'recording';
  $('mic').disabled = !recording && (state.busy || state.transcribing || !state.words.length);
}

function tickMic() {
  const s = Math.floor((Date.now() - rec.startedAt) / 1000);
  $('mic').textContent = `⏹ ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  if (s >= MAX_RECORD_S) stopRecording();
}

async function startRecording() {
  try {
    rec.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    add(div('err', 'Microphone unavailable: ' + (err.name === 'NotAllowedError' ? 'permission denied' : err.message)));
    return;
  }
  rec.chunks = [];
  rec.recorder = new MediaRecorder(rec.stream, MIME ? { mimeType: MIME } : undefined);
  rec.recorder.ondataavailable = (e) => { if (e.data.size) rec.chunks.push(e.data); };
  rec.recorder.onstop = onRecordingStopped;
  rec.recorder.start();
  rec.startedAt = Date.now();
  $('mic').classList.add('rec');
  rec.timer = setInterval(tickMic, 250);
  tickMic();
}

function stopRecording() {
  if (rec.recorder?.state === 'recording') rec.recorder.stop();
}

async function onRecordingStopped() {
  clearInterval(rec.timer);
  rec.stream.getTracks().forEach((t) => t.stop());
  $('mic').classList.remove('rec');
  $('mic').textContent = '🎤';
  const ms = Date.now() - rec.startedAt;
  const blob = new Blob(rec.chunks, { type: rec.recorder.mimeType || MIME || 'audio/webm' });
  if (ms < MIN_RECORD_MS) { add(div('err', 'Too short — tap the mic, speak, then tap again.')); updateMic(); return; }
  await transcribeAndSend(blob);
}

async function transcribeAndSend(blob) {
  state.transcribing = true;
  updateMic();
  const note = add(div('typing', '聞き取り中…'));
  try {
    const words = encodeURIComponent(state.words.join('、').slice(0, 200));
    const res = await api('/api/transcribe?words=' + words, { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    note.remove();
    if (!data.text) { add(div('err', "Didn't catch that — try again.")); return; }
    sendUser(data.text, 'voice');
  } catch (err) {
    note.remove();
    add(div('err', 'Error: ' + err.message));
  } finally {
    state.transcribing = false;
    updateMic();
  }
}

$('mic').onclick = () => (rec.recorder?.state === 'recording' ? stopRecording() : startRecording());
```

- [ ] **Step 4: Verify manually in mock mode**

Run (PowerShell): `$env:LLM_MOCK='1'; $env:PORT='3055'; node server.js`, open http://localhost:3055 in Chrome.
Expected:
1. Add a word, press Start. The 🎤 button is visible and enabled once the first bot message has arrived.
2. Click 🎤, allow the microphone: the button turns red and counts `⏹ 0:01`, `0:02`…
3. Click again after ~2 s: "聞き取り中…" shows briefly, then a user bubble `これはテストです。` appears and the bot replies; the mistakes panel (wide window) shows a `（モック）これはテストです。` entry for turn 1.
4. Click 🎤 and stop within half a second: the "Too short" message appears and nothing is sent.
5. Click 🎤 and deny permission in a fresh profile or via site settings: "Microphone unavailable: permission denied" appears and typing still works.
6. With `LLM_MOCK` unset and no `OPENAI_API_KEY`, the 🎤 button is hidden.

- [ ] **Step 5: Verify against the real Whisper once**

Stop the server. Make sure `.env` has `LLM_MOCK=0` and a real `OPENAI_API_KEY`, then run `node server.js` (PowerShell: `$env:PORT='3055'; node server.js`). Say one Japanese sentence containing a deliberate particle mistake, for example 「私は学校を行きます」.
Expected: the bubble shows the transcript in Japanese, the bot replies, and a correction for `を` → `に` appears in the panel/inline. If the transcript is empty or garbled, check the browser console and the server terminal for the error text.

- [ ] **Step 6: Commit**

```bash
git add public/index.html
git commit -m "feat: record speech, transcribe with Whisper and auto-send" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: PWA (manifest, service worker, icons)

**Files:**
- Create: `public/manifest.webmanifest`, `public/sw.js`, `scripts/make-icons.ps1`
- Create (generated): `public/icon-192.png`, `public/icon-512.png`
- Modify: `public/index.html`

**Interfaces:**
- Consumes: static serving and MIME types for `.webmanifest`/`.png` (Task 5).

- [ ] **Step 1: Create `public/manifest.webmanifest`**

```json
{
  "name": "Kotoba Chat",
  "short_name": "Kotoba",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#f6f4ef",
  "theme_color": "#c8102e",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any maskable" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable" }
  ]
}
```

- [ ] **Step 2: Create `public/sw.js`**

```js
// Cache the app shell (stale-while-revalidate) so the app opens instantly; never cache the API.
const CACHE = 'kotoba-shell';
const SHELL = ['/', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(e.request);
      const network = fetch(e.request)
        .then((res) => { if (res.ok) cache.put(e.request, res.clone()); return res; })
        .catch(() => hit);
      return hit || network;
    }),
  );
});
```

- [ ] **Step 3: Create `scripts/make-icons.ps1`** (draws 言 in white on the accent colour; run on Windows)

```powershell
Add-Type -AssemblyName System.Drawing
$glyph = [string][char]0x8A00   # 言
foreach ($size in 192, 512) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.TextRenderingHint = 'AntiAliasGridFit'
  $g.Clear([System.Drawing.ColorTranslator]::FromHtml('#c8102e'))
  $font = New-Object System.Drawing.Font('Yu Gothic', [single]($size * 0.55), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = 'Center'
  $fmt.LineAlignment = 'Center'
  $rect = New-Object System.Drawing.RectangleF 0, 0, $size, $size
  $g.DrawString($glyph, $font, [System.Drawing.Brushes]::White, $rect, $fmt)
  $out = Join-Path $PSScriptRoot "..\public\icon-$size.png"
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}
```

- [ ] **Step 4: Generate the icons and look at them**

Run (PowerShell): `powershell -ExecutionPolicy Bypass -File scripts\make-icons.ps1`
Then check: `ls -l public/icon-192.png public/icon-512.png` (both exist, non-empty) and open `public/icon-512.png` to confirm a white 言 on a red square.

- [ ] **Step 5: Link the manifest and register the service worker in `public/index.html`**

In `<head>`, after the `<title>` line, add:

```html
<link rel="manifest" href="/manifest.webmanifest" />
<meta name="theme-color" content="#c8102e" />
<link rel="icon" href="/icon-192.png" />
```

Just before `</script>` at the end of the page, add:

```js
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
```

- [ ] **Step 6: Verify installability locally**

Run `node server.js` (mock mode, port 3055), open http://localhost:3055 in Chrome, then DevTools, Application tab. Expected: Manifest shows name "Kotoba Chat" with both icons and no errors; Service Workers shows `sw.js` activated; the address bar offers an install icon (localhost counts as secure). Reload once and confirm the page still opens with the server stopped (the shell is cached; chatting will fail, which is expected).

- [ ] **Step 7: Commit**

```bash
git add public/manifest.webmanifest public/sw.js public/icon-192.png public/icon-512.png scripts/make-icons.ps1 public/index.html
git commit -m "feat: make the app installable (PWA)" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Env docs, README and deploy checklist

**Files:**
- Modify: `.env.example`, `README.md`

**Interfaces:**
- Consumes: env var names from Global Constraints.

- [ ] **Step 1: Update `.env.example`**

Replace the line `# Set to 1 to try the UI without any API key (canned replies)` block at the bottom so the file ends with:

```
# --- Voice input (Whisper) ---
OPENAI_API_KEY=sk-...

# --- Optional shared password for the hosted app (leave empty locally) ---
APP_PASSWORD=

# Set to 1 to try the UI without any API key (canned replies, fake transcription)
LLM_MOCK=0
PORT=3000
```

Also change the Option A model line to `LLM_MODEL=claude-sonnet-5-5` (keep the other options unchanged).

- [ ] **Step 2: Read `README.md`, then append a "Voice, mobile and hosting" section**

Read the file first and keep its existing content. Append:

```markdown
## Voice input, mistakes panel and mobile

- Tap 🎤, speak Japanese, tap again. The audio is transcribed with OpenAI Whisper (`OPENAI_API_KEY`) and sent to the bot automatically.
- Mistakes show in the right-hand panel on wide screens (>= 1100 px) and under your message on narrow screens.
- Microphone access needs https (or localhost), so on a phone use the hosted version.

## Hosting on Railway (and installing on Android)

1. Push this repo to GitHub and create a Railway service from it. Start command: `npm start`.
2. Set these variables in Railway: `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`, `OPENAI_API_KEY`, `APP_PASSWORD` (choose a long password). Leave `LLM_MOCK` unset or `0`. Railway provides `PORT` itself.
3. Generate a public domain for the service and open it in Chrome on your Android phone.
4. Enter the password once, then Chrome menu, Install app.

Never commit `.env`; it is gitignored.

## Tests

`npm test` runs the unit tests in `tests/` with Node's built-in test runner.
```

- [ ] **Step 3: Run the tests and a final secret scan**

Run:
```bash
npm test
grep -rnE 'sk-[A-Za-z0-9_-]{20,}' --exclude-dir=.git --exclude=.env .
git status --short
```
Expected: all tests pass; the `grep` prints nothing; `git status` lists only `.env.example` and `README.md` as modified and no `.env`.

- [ ] **Step 4: Commit**

```bash
git add .env.example README.md
git commit -m "docs: document voice input, env vars and Railway deploy" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Deploy and verify (done by the user, with the GitHub repo connected)**

```bash
git remote add origin <your-github-repo-url>
git push -u origin main
```
Then in Railway: confirm the build succeeds and the variables from the README are set. Verify on the hosted URL:
1. Opening the URL asks for the password; a wrong one re-prompts; the right one loads the app.
2. On Android Chrome, Install app adds the icon; the installed app opens full-screen.
3. Start a conversation, record a Japanese sentence with a deliberate mistake: the transcript appears as your bubble, the bot replies, and the correction shows inline under your bubble.
4. On a desktop browser (window wider than 1100 px) the same mistake shows in the right panel.
5. Check the Anthropic and OpenAI usage pages after the session: costs should be a few cents.

---

## Self-review notes

- **Spec coverage:** Whisper transcription (Tasks 4, 5, 7), auto-send with the speech-recognition hint (Tasks 5, 7), multiple corrections capped at 3 (Task 3, prompt in Task 5), running-list panel and inline mobile layout (Task 6), PWA (Task 8), password gate (Tasks 2, 5, 6), Railway deploy and env vars (Task 9), own git repo (Task 1), `max_tokens` 2000 (Task 5), recording limits and error cases (Task 7), unit tests (Tasks 2–4) plus manual checks (Tasks 5–8). Costs need no code.
- **Type consistency:** `corrections` items are `{original, corrected, explanation}` in the prompt (Task 5), `parseReply` (Task 3), `corrHtml` and `addMistakes` (Task 6). `sendUser(text, source)` is defined in Task 6 and called in Task 7. `api()` and `updateMic()` are defined before use (Task 6 stub, Task 7 real).
- **Known limits:** Whisper can hallucinate a phrase on near-silence; the 700 ms minimum and the target-word prompt reduce this but do not remove it. If it shows up in practice, add a small blocklist of known phantom phrases to the client.
