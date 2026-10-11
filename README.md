# Kotoba Chat 言葉

Give it a list of Japanese words and a JLPT level; it starts a guided conversation in which every word comes up — and nudges you to use them yourself.

## Run

```bash
cp .env.example .env      # add your API key
npm start                 # → http://localhost:3000
```

No dependencies — just Node 18+. To try the UI without a key, set `LLM_MOCK=1` in `.env`.

## Features

- Word list (newline / comma / 、 separated) + level N5–N1 + optional scenario
- Chips that turn green as each word is used (by the partner or by you)
- Gentle correction of your previous message
- Furigana on every kanji (toggle), English translation blurred until clicked (toggle)
- Per-message hint, and 🔊 read-aloud via the browser's built-in Japanese voice
- Token counter so you can keep an eye on cost

## How it works

`server.js` keeps your API key server-side and sends each turn to an OpenAI-compatible `/chat/completions` endpoint. The system prompt carries the word list, the words *not yet used*, and the level; the model answers in JSON (`japanese` with `{漢字|かんじ}` furigana markup, `english`, `correction`, `used_words`, `hint`, `finished`). The UI lives in `public/index.html`.

## Model choice

Default is Claude Haiku 4.5 (good Japanese, cheap). Swap to any other model by changing the three `LLM_*` vars — see `.env.example`. A full 10–15-turn conversation is on the order of tens of thousands of input tokens, i.e. a few cents at most on small models.
