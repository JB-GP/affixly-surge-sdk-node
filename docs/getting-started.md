# Getting started with `affixly-surge-sdk` (Node)

This is a Node/TypeScript port of the Python `affixly-surge-sdk`. It wraps the official Anthropic, OpenAI, and Google Gemini SDKs so that every successful API call is reported to your Surge backend in the background.

## 1. Install

```bash
npm install affixly-surge-sdk
```

Plus whichever provider SDK you use:

```bash
npm install @anthropic-ai/sdk
npm install openai
npm install @google/genai
```

Node 18+ is required (the package uses the global `fetch` API).

## 2. Configure once at startup

```ts
import { configure } from 'affixly-surge-sdk';

configure({
  surgeApiUrl: process.env.SURGE_API_URL!,
  surgeApiKey: process.env.SURGE_SDK_KEY!,
  productLine: 'my-app',
  defaultTags: { team: 'engineering' },
});
```

If you prefer env vars, the same three keys (`SURGE_API_URL`, `SURGE_SDK_KEY`, `SURGE_PRODUCT_LINE`) are picked up automatically — calling `configure()` is then only needed if you want to set `defaultTags` or override any of the env values.

## 3. Use the wrapped client

### Anthropic

```ts
import { anthropic } from 'affixly-surge-sdk';

const client = new anthropic.Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const response = await client.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello' }],
  surgeTags: { feature: 'chat', customer_id: 'cust_abc' },
});
```

### OpenAI

```ts
import { openai } from 'affixly-surge-sdk';

const client = new openai.OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const response = await client.chat.completions.create({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Hello' }],
  surgeTags: { feature: 'qa' },
});
```

### Google Gemini

```ts
import { gemini } from 'affixly-surge-sdk';

const client = new gemini.GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const response = await client.models.generateContent({
  model: 'gemini-1.5-flash',
  contents: 'Hello',
  surgeTags: { feature: 'demo' },
});
```

## 4. What gets reported

For every successful provider call, a JSON event like this is POSTed to `{surgeApiUrl}/api/events`:

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "input_tokens": 100,
  "output_tokens": 50,
  "cost_usd": 0.001050,
  "requests": 1,
  "product_line": "my-app",
  "feature": "chat",
  "customer_id": "cust_abc"
}
```

- `cost_usd` is a client-side estimate using a built-in pricing table (per million tokens, rounded to 6 decimal places). It is meant as a fast attribution signal — your Surge backend can recompute authoritative costs if needed.
- `feature` and `customer_id` come from the merged `defaultTags` + per-call `surgeTags` (per-call wins on conflicts).
- Tag values longer than 256 chars are truncated with a warning.

## 5. Operational guarantees

- **Fire-and-forget.** The provider call resolves before the report is sent. The caller never waits.
- **Failures are silent for the caller.** Network errors, non-2xx responses, and timeouts are logged at debug level. Your application is never affected.
- **Bounded concurrency.** At most 4 reports are in-flight at any time.
- **Timeout.** Each report has a 5-second timeout.
- **No redirects.** The Bearer token is never leaked to a redirect target — 3xx responses are dropped.
- **Graceful shutdown.** A `beforeExit` hook tries to drain pending reports.
- **HTTPS in production.** Non-HTTPS `surgeApiUrl` logs a warning unless the host is `localhost` or `127.0.0.1`.

## 6. Roll back

To stop tracking a particular call site, swap the import back to the real SDK:

```ts
// Before
import { anthropic } from 'affixly-surge-sdk';
const client = new anthropic.Anthropic({ apiKey: '...' });

// After
import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic({ apiKey: '...' });
```

No further code changes required.

## 7. Not in v1

- Streaming responses (`messages.stream()`, `chat.completions.create({ stream: true })`, `generateContentStream`) are passed through but not tracked.
- Browser / edge runtime build. Node 18+ only.
- Stripe integration (lives on the Surge backend, not the SDK).
