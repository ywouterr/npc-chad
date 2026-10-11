# Kotoba Chat: voice input, mistakes panel, installable app

Date: 2026-10-11
Status: draft, awaiting review

## Goal

Let the learner speak Japanese instead of typing. Speech is transcribed to Japanese text, sent to the bot automatically and analysed. All mistakes are collected: in a right-hand panel on desktop, inline in the chat on mobile. The app is hosted online so it can be installed on an Android phone as a PWA and used for ~20 minutes a day.

## Decisions already made

| Topic | Decision |
|---|---|
| Transcription | OpenAI Whisper API (`whisper-1`), called from the server, `language=ja` |
| After recording | Auto-send: no review step |
| Mistakes panel | Running list for the whole session, newest first |
| Mistakes on mobile | Inline, under the user's message they refer to |
| Phone | Android, installed as a PWA from a hosted https URL |
| Hosting | Railway (own git repo, env vars for secrets) |
| Chat model | `claude-sonnet-5-5` (unchanged) |

## Non-goals

Native APK/iOS build, accounts or multiple users, saving sessions across devices, offline chat, streaming transcription, a transcript review step, spaced repetition or exporting mistakes.

## Architecture

Same shape as today: a zero-dependency Node server plus one static page. New pieces are marked **new**.

```
Browser (index.html)                          Server (server.js)                 External
  mic button -> MediaRecorder (<= 60 s)
  audio blob  -- POST /api/transcribe -->     check password                     
                                              forward to Whisper  ------------>  OpenAI /v1/audio/transcriptions
  <-- { text } --------------------------
  text -> user bubble -- POST /api/chat -->   check password, build prompt  ---> Anthropic (OpenAI-compat)
  <-- { reply (incl. corrections[]) } ----
  render bot reply, mistakes panel / inline
```

Files:

- `server.js`: add `POST /api/transcribe`, password check, `voice` flag in `/api/config`, multi-correction reply parsing. Raise chat `max_tokens` from 900 to 2000 (multiple corrections, thinking).
- `lib/` **new**: `parse-reply.js` (reply normalisation) and `auth.js` (password check), pulled out of `server.js` so they can be unit tested. No other refactoring.
- `public/index.html`: mic button, mistakes panel, layout changes, auth prompt.
- `public/manifest.webmanifest`, `public/sw.js`, `public/icon-192.png`, `public/icon-512.png` **new**.
- `.gitignore` **new**: `.env`, `node_modules`.

## Voice input

**Recording (client).**
- A mic button sits next to Send in the composer. Tap to start, tap again to stop. While recording it pulses and shows elapsed time. Auto-stops at 60 s.
- Uses `navigator.mediaDevices.getUserMedia({ audio: true })` and `MediaRecorder` with the first supported type of `audio/webm;codecs=opus`, `audio/mp4`. This needs https (or localhost), which is why the phone needs the hosted version.
- On stop, the blob is POSTed as the raw request body to `/api/transcribe` with its `Content-Type`. The text input and Send button stay as a typing fallback.
- The mic is disabled while a bot turn is in progress and before a conversation has started. If microphone permission is denied, show an inline error that says so.
- If `/api/config` reports `voice: false` (no OpenAI key), the mic button is hidden.

**Transcription (server).**
- `POST /api/transcribe` reads the binary body (limit 2 MB), rejects other sizes with 413, and sends a `multipart/form-data` request to `https://api.openai.com/v1/audio/transcriptions` using Node's built-in `FormData`/`Blob`: `model=whisper-1`, `language=ja`, and `prompt` set to the target-word list so Whisper is biased toward those words (the client sends them in a query parameter).
- Returns `{ text }`. Empty text (silence) returns `{ text: "" }` and the client shows "Didn't catch that, try again" instead of sending.
- Whisper failures return the upstream status and a short message; the client shows it in the chat like other errors.
- In mock mode (`LLM_MOCK=1`) it returns a fixed Japanese sentence, so the whole flow can be tried without keys.

**Auto-send.** A non-empty transcript is added as a user bubble and sent to `/api/chat` with `source: "voice"`. The system prompt then adds: "The learner's message came from speech recognition. Ignore punctuation, spacing, kanji-vs-kana choices and obvious mishearings; only correct genuine grammar, word-choice and conjugation mistakes." This limits false mistakes caused by transcription errors, since there is no review step.

## Mistake analysis

The reply schema changes from a single `correction` to `corrections`, an array (empty when the message was fine):

```json
"corrections": [
  { "original": "…", "corrected": "…", "explanation": "short English explanation" }
]
```

- The system prompt is updated: list every genuine mistake in the learner's last message, at most 3 per turn, most important first; never correct the "(start)" message.
- `parse-reply.js` accepts the new `corrections` array and also the old single `correction` object (wrapping it), drops entries without a `corrected` string, and caps the list at 3.
- The client keeps `state.mistakes`, a list of `{ turn, original, corrected, explanation }`, appended on each reply and cleared when a new conversation starts. It is held in memory for the session only.

## Layout

- **Wide screens (>= 1100px):** three columns: settings (320px) | chat | mistakes panel (320px). The panel header shows the count. Each entry shows the original struck through, the corrected text in bold, the explanation, and "turn N". Newest on top. Empty state: "No mistakes yet". The panel is a sticky, independently scrolling column.
- **Narrower screens (< 1100px, including phones):** no panel. Corrections render directly beneath the user bubble they refer to, using the existing warning-box style, added when the bot's reply arrives. The old placement above the bot's bubble is removed.
- Inline corrections are also rendered on wide screens but hidden with CSS, so there is one rendering path and no duplicate logic.
- The existing 800px stacking of the settings column on mobile is kept.

## Installable app (PWA)

- `manifest.webmanifest`: name "Kotoba Chat", `display: standalone`, theme/background colours from the existing palette, 192px and 512px PNG icons. The icons are PNGs, generated once from a simple 言 glyph on the accent colour.
- `sw.js`: cache-first for the static shell (`/`, manifest, icons), network-only for `/api/*`. Cache name carries a version string so updates replace the old cache.
- `index.html` links the manifest and registers the service worker.
- Install flow on Android Chrome: open the URL, menu, Install app.

## Access control

The site will be on a public URL and spends API credit, so `/api/*` is protected by one shared password.

- Server env var `APP_PASSWORD`. If unset (local use), no check is made.
- The client sends it in an `x-app-key` header. On a 401 it asks for the password with a small prompt and stores it in `localStorage`. Static files stay public; they contain no secrets.
- Comparison uses `crypto.timingSafeEqual`; a wrong password is answered after a 1-second delay.

## Deployment (Railway)

- The project gets its own git repo (the home directory is already a repo, so this must be a separate one), with `.gitignore` excluding `.env`.
- Railway start command: `npm start`; it provides `PORT`, which the server already reads.
- Environment variables to set on Railway: `LLM_API_KEY`, `LLM_MODEL`, `LLM_BASE_URL`, `OPENAI_API_KEY`, `APP_PASSWORD`. `LLM_MOCK` stays 0.
- `.env.example` gets `OPENAI_API_KEY` and `APP_PASSWORD` entries with placeholders only.
- Railway's current pricing and free-tier limits have not been checked and need confirming before deploying.

## Costs

Chat estimate is unchanged (about $2/month for 10 sessions on Sonnet 5.5, possibly higher with thinking tokens). Whisper is $0.006 per minute of audio: at most about $1.20/month if all 200 minutes were speech, realistically $0.30–0.60 because the learner speaks only part of the time.

## Error handling summary

| Case | Behaviour |
|---|---|
| Mic permission denied / no mic | Inline error under the composer, typing still works |
| Recording > 60 s | Auto-stop and transcribe what was recorded |
| Silence / empty transcript | "Didn't catch that" message, nothing sent |
| Whisper or network error | Error line in chat, user can record again |
| Wrong or missing password | Prompt for password, retry |
| Reply JSON malformed | Existing single retry, unchanged |
| Reply without corrections | Treated as no mistakes |

## Testing

No test framework is added; Node's built-in `node:test` is enough.

- Unit tests: `parse-reply.js` (new array form, old single form, missing/invalid entries, cap of 3) and `auth.js` (no password configured, correct, wrong).
- Manual checks, in mock mode first: record, transcribe, auto-send, panel on a wide window, inline corrections in a narrow window (browser dev tools phone mode), password prompt.
- Manual on the real deployment from the Android phone: install via Chrome, record in Japanese, confirm a deliberate grammar mistake appears inline, confirm the same session on desktop shows it in the panel.

## Open points for review

- Panel breakpoint 1100px and the 3-mistakes-per-turn cap are starting values to tune once used.
- Using `whisper-1` for price; newer OpenAI transcription models may be more accurate for Japanese but are priced differently. They can be swapped by changing one constant after checking current pricing.
