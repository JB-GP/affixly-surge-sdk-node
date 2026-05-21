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
- When a model override fires (see [Model overrides](#5-model-overrides)), the event also includes `requested_model` and `requested_cost_usd` (the cost the original model would have incurred). These fields are omitted entirely when no override occurred.
- For streaming calls (0.3.0+), the same event shape is reported — usage is captured from the stream and reported when iteration completes.

## 5. Model overrides

The SDK can redirect calls to a different model than the one declared at the
call site. Useful for multi-tenant SaaS where plan tier should determine the
model used — the call site stays clean, the routing rule lives in one place.

### Global overrides — `modelOverrides` in `configure()`

```ts
import { configure } from 'affixly-surge-sdk';

configure({
  surgeApiUrl: '...',
  surgeApiKey: 'surge_sk_...',
  productLine: 'my-app',
  modelOverrides: {
    'claude-opus-4-5': 'claude-sonnet-4-6',  // all Opus calls become Sonnet
    'claude-opus-4-6': 'claude-sonnet-4-6',
  },
});
```

### Per-request overrides — `surgeModel` option

```ts
const PLAN_MODEL_MAP: Record<string, string> = {
  starter:  'claude-haiku-4-5',
  solo_pro: 'claude-sonnet-4-6',
  business: 'claude-opus-4-5',
};

function getTenantModel(tenantId: string): string {
  const plan = getTenantPlan(tenantId);
  return PLAN_MODEL_MAP[plan] ?? 'claude-sonnet-4-6';
}

const response = await client.messages.create({
  model: 'claude-opus-4-5',                 // intent declared in code
  max_tokens: 1024,
  messages: [{ role: 'user', content: prompt }],
  surgeModel: getTenantModel(tenantId),     // resolved at runtime
  surgeTags: { feature: 'chat', customer_id: tenantId },
});
```

Both `surgeModel` and `surgeTags` are stripped from the args before they
reach the provider SDK.

### Precedence

1. `surgeModel` (per-request) — wins outright
2. `modelOverrides` (global) — applies when there's no per-request value
3. `model:` in the call — used unchanged when neither override matches

### What the dashboard shows

When an override fires, Surge logs both the requested and the actual model
on the event. The Usage table reveals a "Requested" column showing the
original model the call asked for. The Overview surfaces a "Savings from
model overrides" card with the cost delta this month.

### What this does *not* do

- The SDK does not validate that the override target is a real model name. A
  typo will reach the provider unchanged and produce a provider-side error.
- The SDK does not block or rate-limit based on tier. That's app logic.
- The SDK does not match model names by regex or wildcard. Exact match only.

## 6. Operational guarantees

- **Fire-and-forget.** The provider call resolves before the report is sent. The caller never waits.
- **Failures are silent for the caller.** Network errors, non-2xx responses, and timeouts are logged at debug level. Your application is never affected.
- **Bounded concurrency.** At most 4 reports are in-flight at any time.
- **Timeout.** Each report has a 5-second timeout.
- **No redirects.** The Bearer token is never leaked to a redirect target — 3xx responses are dropped.
- **Graceful shutdown.** A `beforeExit` hook tries to drain pending reports.
- **HTTPS in production.** Non-HTTPS `surgeApiUrl` logs a warning unless the host is `localhost` or `127.0.0.1`.

## 7. Roll back

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

## 8. Streaming

Streaming is fully tracked as of 0.3.0. Same `surgeTags` + `surgeModel` work; usage is captured as chunks flow through and reported when iteration completes.

```ts
// Anthropic streaming
const stream = await client.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 1024,
  messages: [...],
  stream: true,
  surgeTags: { feature: 'chat' },
});
for await (const event of stream) { /* ... */ }
// Usage reported after the loop exits

// OpenAI streaming — SDK auto-injects stream_options.include_usage=true
const stream = await client.chat.completions.create({
  model: 'gpt-4o',
  messages: [...],
  stream: true,
  surgeTags: { feature: 'chat' },
});
for await (const chunk of stream) { /* ... */ }

// Gemini streaming
const stream = await client.models.generateContentStream({
  model: 'gemini-2.5-flash',
  contents: 'Hello',
  surgeTags: { feature: 'chat' },
});
for await (const chunk of stream) { /* ... */ }
```

**Notes:**
- The SDK forces `stream_options.include_usage=true` for OpenAI streams so the final chunk carries `usage`. If you iterate raw chunks you'll see one extra final chunk with `usage` populated — same shape as if you'd set the option yourself.
- For Anthropic, both `messages.create({ stream: true })` (the `Stream` shape) and `messages.stream({})` (the `MessageStream` shape with `.finalMessage()`, `.on('text', cb)`, etc.) are tracked. Helper methods on the latter are preserved by the wrapping Proxy.
- Early `break` from iteration still reports whatever was collected — partial usage is correct usage.

## 9. Not in v1

- Browser / edge runtime build. Node 18+ only.
- Stripe integration (lives on the Surge backend, not the SDK).
