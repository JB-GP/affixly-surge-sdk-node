# affixly-surge-sdk

Lightweight cost-attribution wrapper for the Anthropic, OpenAI, and Google Gemini Node SDKs. Track AI spend by product line, feature, and customer with a one-line import change — no proxy, no infrastructure, no code rewrite.

> Node port of the [Python `affixly-surge-sdk`](https://pypi.org/project/affixly-surge-sdk/). Same interface, same event shape, same fire-and-forget pattern.

## Install

```bash
npm install affixly-surge-sdk
```

Install alongside whichever provider SDK you use:

```bash
npm install @anthropic-ai/sdk        # Anthropic (Claude)
npm install openai                   # OpenAI (GPT)
npm install @google/genai            # Google Gemini
```

## Quick start

```ts
import { configure, anthropic } from 'affixly-surge-sdk';

configure({
  surgeApiUrl: 'https://your-surge-backend-url',
  surgeApiKey: 'surge_sk_your_key_here',
  productLine: 'my-app',
});

const client = new anthropic.Anthropic({ apiKey: 'sk-ant-...' });
const response = await client.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello' }],
});
// Tracked automatically. No further code changes needed.
```

Get your `surgeApiKey` from your Surge dashboard at **Settings → SDK → Generate API key**.

## Per-call tags

Attribute spend to a specific feature or customer:

```ts
const response = await client.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 1024,
  messages: [{ role: 'user', content: '...' }],
  surgeTags: { feature: 'summarize', customer_id: 'cust_abc123' },
});
```

`surgeTags` is stripped from the request before it reaches the provider SDK.

## Environment variables

The same config keys can be set via env vars as fallback:

| Env var | Maps to |
|---|---|
| `SURGE_API_URL` | `surgeApiUrl` |
| `SURGE_SDK_KEY` | `surgeApiKey` |
| `SURGE_PRODUCT_LINE` | `productLine` |

## How it works

- The wrapper intercepts `messages.create()` (or the equivalent for OpenAI / Gemini), reads token counts from the response, and POSTs a usage event to your Surge backend in the background.
- Your AI calls go directly to the provider — no proxy, no added latency.
- Reports are fire-and-forget: the provider call resolves before the report is sent.
- If Surge is unreachable, the report is dropped silently. Your application is never affected.

## Supported providers

| Provider | Import | What's tracked |
|---|---|---|
| Anthropic | `import { anthropic } from 'affixly-surge-sdk'` | `messages.create()` |
| OpenAI | `import { openai } from 'affixly-surge-sdk'` | `chat.completions.create()` |
| Google Gemini | `import { gemini } from 'affixly-surge-sdk'` | `models.generateContent()` |

**Streaming is not tracked in v1.**

### Gemini SDK note

This package wraps [`@google/genai`](https://www.npmjs.com/package/@google/genai) — the newer Google GenAI SDK. The exposed class is `GoogleGenAI`:

```ts
import { gemini } from 'affixly-surge-sdk';
const client = new gemini.GoogleGenAI({ apiKey: 'AIza...' });
```

## Rolling back

The wrappers are drop-in replacements. To remove cost tracking from a code path, change the import back to the real SDK:

```ts
// Before
import { anthropic } from 'affixly-surge-sdk';
const client = new anthropic.Anthropic({ apiKey: '...' });

// After
import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic({ apiKey: '...' });
```

No other code changes required.

## Documentation

Full guide: [`docs/getting-started.md`](docs/getting-started.md).

## License

MIT
