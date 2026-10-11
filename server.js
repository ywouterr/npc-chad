// Kotoba Chat — tiny zero-dependency server (Node 18+)
// Serves the UI and proxies chat turns to any OpenAI-compatible LLM endpoint.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const PUBLIC = join(ROOT, 'public');

const LEVELS = ['N5', 'N4', 'N3', 'N2', 'N1'];

function systemPrompt({ words, remaining, level, scenario }) {
  return `You are a warm, patient Japanese conversation partner for a learner at JLPT ${level} level.

TARGET WORDS (the whole list): ${words.join('、')}
NOT YET USED: ${remaining.length ? remaining.join('、') : '(all used — start wrapping up naturally)'}
${scenario ? `SCENARIO: ${scenario}` : 'SCENARIO: choose a natural everyday situation in which the target words fit well.'}

YOUR JOB
- Lead a natural, guided conversation (roughly 8–15 exchanges) in which EVERY target word occurs.
- Weave in 1–2 not-yet-used target words per turn, and ask questions that invite the learner to use target words themselves.
- Apart from the target words, keep grammar and vocabulary at or below ${level}. Short sentences: 1–3 per turn, usually ending with a question.
- If the learner's last message has mistakes, give ONE gentle, concise correction. If it was fine, correction is null. Never correct the "(start)" message.
- If the learner writes in English or says they don't know, help them with a simple model answer and keep going.
- When all target words have been used, wrap up the conversation kindly and set "finished": true.

OUTPUT — respond with ONLY a JSON object, no markdown fences:
{
  "correction": null | { "original": "...", "corrected": "...", "explanation": "short English explanation" },
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
      max_tokens: 900,
      messages: [{ role: 'system', content: system }, ...messages],
    }),
  });
  if (!res.ok) throw new Error(`LLM error ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const data = await res.json();
  return { text: data.choices?.[0]?.message?.content ?? '', usage: data.usage || null };
}

function parseReply(text) {
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s < 0 || e < s) throw new Error('No JSON in model reply');
  const r = JSON.parse(text.slice(s, e + 1));
  if (typeof r.japanese !== 'string') throw new Error('Reply missing "japanese"');
  return {
    correction: r.correction && r.correction.corrected ? r.correction : null,
    japanese: r.japanese,
    english: String(r.english || ''),
    used_words: Array.isArray(r.used_words) ? r.used_words.map(String) : [],
    hint: String(r.hint || ''),
    finished: !!r.finished,
  };
}

function mockReply({ remaining, messages }) {
  const w = remaining.slice(0, 2);
  const turn = messages.filter((m) => m.role === 'assistant').length;
  return {
    correction: null,
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
  let messages = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-60)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
  if (!words.length) throw Object.assign(new Error('Give at least one word'), { status: 400 });
  if (!messages.length) messages = [{ role: 'user', content: '(start) The learner is ready — please open the conversation.' }];

  if (MOCK) return { reply: mockReply({ remaining, messages }), usage: null };
  if (!API_KEY) throw Object.assign(new Error('LLM_API_KEY is not set (see .env.example), or run with LLM_MOCK=1'), { status: 500 });

  const system = systemPrompt({ words, remaining, level, scenario });
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

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/api/chat') {
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 500_000) throw Object.assign(new Error('Request too large'), { status: 413 });
      }
      const out = await handleChat(JSON.parse(raw || '{}'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(out));
    }
    if (req.method === 'GET' && req.url === '/api/config') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ model: MOCK ? 'mock' : MODEL }));
    }
    if (req.method === 'GET') {
      const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
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
