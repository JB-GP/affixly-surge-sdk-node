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

### OpenAI audio transcription

`audio.transcriptions.create()` is also wrapped. It is billed per minute of
audio, not per token, so the usage event carries the audio-duration cost with 0
tokens. Pass `response_format: 'verbose_json'` so the response includes
`duration` — without it the call is still reported, but with 0 duration (cost
0).

```ts
import fs from 'node:fs';
import { openai } from 'affixly-surge-sdk';

const client = new openai.OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const transcript = await client.audio.transcriptions.create({
  model: 'whisper-1',
  file: fs.createReadStream('call.mp3'),
  response_format: 'verbose_json',
  surgeTags: { feature: 'voicemail' },
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
  "customer_id": "cust_abc",
  "plan": "business"
}
```

- `cost_usd` is a client-side estimate using a built-in pricing table (per million tokens, rounded to 6 decimal places). It is meant as a fast attribution signal — your Surge backend can recompute authoritative costs if needed.
- `feature`, `customer_id`, and `plan` come from the merged `defaultTags` + per-call `surgeTags` (per-call wins on conflicts). `plan` (spec §4.2) drives per-plan cost attribution on the dashboard. Any of the three is `null` when the corresponding tag is unset.
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

## 6. Product event tracking

Cost reporting answers "how much did AI usage cost?" — `track()` answers "what
did users do?". It records arbitrary product events against the same product
line and tenant identity, so spend and behavior live in one place.

```ts
import { configure, track } from 'affixly-surge-sdk';

configure({
  surgeApiUrl: process.env.SURGE_API_URL!,
  surgeApiKey: process.env.SURGE_SDK_KEY!,
  productLine: 'parse',
});

track('parse.repo.connected', 'github_username_or_user_id', {
  repo: 'owner/repo',
  language: 'python',
});
```

This POSTs to `{surgeApiUrl}/api/track`:

```json
{
  "event": "parse.repo.connected",
  "tenant": "github_username_or_user_id",
  "product": "parse",
  "properties": { "repo": "owner/repo", "language": "python" }
}
```

- `product` is the configured `productLine` (`null` if unset).
- `tenant` is the stable identifier for the acting user/tenant.
- `properties` is optional arbitrary metadata; when omitted it is sent as `{}`.
- Same operational guarantees as cost reporting (next section): fire-and-forget, bounded concurrency, 5s timeout, drained on exit, silent on failure.
- Calling `track()` before `configure()` (no `surgeApiUrl`) logs a warning and sends nothing.

### Quota events — `trackQuotaEvent()`

`trackQuotaEvent()` is a convenience wrapper around `track()` that the other
Affixly products use to report spend-ceiling / quota-limit hits (spec §1.5):

```ts
import { trackQuotaEvent } from 'affixly-surge-sdk';

trackQuotaEvent('ceiling_hit', 'forge', 'cust_42', 'maker', {
  spend_usd: 9.12,
  ceiling_usd: 9.0,
});
```

- Signature: `trackQuotaEvent(kind, productLine, customerId, plan?, fields?)`.
- `kind` is `'ceiling_hit'` or `'limit_hit'` (or a full `'quota.*'` event name).
  It posts a `quota.ceiling_hit` / `quota.limit_hit` product event scoped to
  `customerId`, with properties `{ product_line, customer_id, plan, ...fields }`.
  `null` / `undefined` properties are dropped.
- It delegates to `track()`, so it inherits the same fire-and-forget guarantees.

## 7. Operational guarantees

### Provider-call failure vs reporting failure

These are two independent failure modes, kept separate by design:

- **Provider-call failure.** If the underlying provider/API call throws (rate
  limit, bad request, network error, …), that error propagates to your code
  **unchanged**. Surge never catches, wraps, retries, or swallows it — the
  wrapper reports usage only *after* a call returns, so a call that throws
  reports nothing.
- **Reporting failure.** If sending the usage/track report to Surge fails
  (network error, non-2xx, timeout), it is isolated: logged at debug level and
  then dropped. It is never thrown into your code, and your provider result is
  unaffected. Set `SURGE_SDK_DEBUG=1` to surface these debug logs, or register a
  handler with `setDiagnostics()` (see [§8](#8-process-lifecycle)) to observe
  them programmatically.

### Guarantees

- **Fire-and-forget.** The provider call resolves before the report is sent. The caller never waits.
- **Failures are silent for the caller.** Network errors, non-2xx responses, and timeouts are logged at debug level. Your application is never affected.
- **Bounded concurrency.** At most 4 reports are in-flight at any time.
- **Timeout.** Each report has a 5-second timeout.
- **No redirects.** The Bearer token is never leaked to a redirect target — 3xx responses are dropped.
- **Graceful shutdown.** A `beforeExit` hook tries to drain pending reports (see [§8](#8-process-lifecycle) for when that isn't enough).
- **HTTPS in production.** Non-HTTPS `surgeApiUrl` logs a warning unless the host is `localhost` or `127.0.0.1`.
- **Over-quota is not an error.** When the backend responds with `X-Surge-Quota: exceeded`, the SDK logs a single `console.warn` per process and keeps running. Over-quota events are dropped server-side (they don't count against your plan) and nothing is thrown. This is the expected behavior at the free/over-quota boundary; upgrade the plan to resume ingestion.

## 8. Process lifecycle

Queued reports are drained automatically on normal process exit via a
`beforeExit` hook. Two common shapes need nothing extra:

- **Long-running servers** — fire-and-forget. Reports flow out in the background
  while the process stays alive.
- **Short-lived scripts** — the `beforeExit` drain flushes queued reports before
  the process exits normally.

**Serverless** is the exception. Platforms such as AWS Lambda, Vercel, and Cloud
Functions may freeze the process between invocations before `beforeExit` runs,
so queued reports can be lost. Drain explicitly at the end of the handler with
`flush()`:

```ts
import { flush } from 'affixly-surge-sdk';

// AWS Lambda / Vercel style handler
export const handler = async (event) => {
  const result = await doWork(event); // AI calls happen in here
  await flush(2000);                  // drain queued reports before the freeze
  return result;
};
```

- `flush(timeoutMs?) => Promise<boolean>` awaits until queued usage/track reports
  have been sent, or `timeoutMs` elapses. It resolves `true` if everything
  drained and `false` on timeout. Omit `timeoutMs` to wait indefinitely.
- This is the one place it's correct to `await` Surge. In a request/response
  path on a long-running server, keep it fire-and-forget — don't gate the user
  response on a flush.

### Observing dropped reports — `setDiagnostics()`

Reporting failures are never thrown (see §7). To observe them without changing
that behavior, register an `onReportError` handler:

```ts
import { setDiagnostics } from 'affixly-surge-sdk';

setDiagnostics({
  onReportError: (err) => metrics.increment('surge.report_error'),
});
```

`onReportError(err)` is called whenever a usage/track report fails. It is
opt-in, never alters failure behavior (Surge still never throws), and a handler
that itself throws is caught and ignored.

## 9. Compatibility & versioning

- **Node:** `>= 18` (the package uses the global `fetch` API).
- **SemVer:** this package follows [Semantic Versioning](https://semver.org/).
- **Provider SDKs** are optional peer dependencies — install only the ones you
  use:

  | Peer dependency | Supported range |
  |---|---|
  | `@anthropic-ai/sdk` | `>=0.20` |
  | `openai` | `>=4` |
  | `@google/genai` | `>=1` |

- The package version is single-sourced in `package.json` and exposed at runtime
  via the `version` export, injected at build time — there is no second
  hard-coded copy to drift:

  ```ts
  import { version } from 'affixly-surge-sdk';
  console.log(version); // e.g. "0.7.0"
  ```

See [`CHANGELOG.md`](../CHANGELOG.md) for the release history.

## 10. Roll back

To stop tracking a particular call site, swap the import back to the real SDK
**and remove any Surge-only options from that call site**. `surgeTags` and
`surgeModel` are recognized only by the wrapper, which strips them before
calling the provider. A bare provider client does not know them, so if you leave
them in place the provider receives unknown parameters and rejects the request.

```ts
// Before
import { anthropic } from 'affixly-surge-sdk';
const client = new anthropic.Anthropic({ apiKey: '...' });
const res = await client.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello' }],
  surgeTags: { feature: 'chat', customer_id: 'cust_abc' }, // Surge-only
});

// After
import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic({ apiKey: '...' });
const res = await client.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello' }],
  // surgeTags / surgeModel removed — the bare SDK would reject them
});
```

## 11. Streaming

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

## 12. Not in v1

- Browser / edge runtime build. Node 18+ only.
- Stripe integration (lives on the Surge backend, not the SDK).
