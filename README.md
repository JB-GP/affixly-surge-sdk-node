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

Attribute spend to a specific feature, customer, or plan:

```ts
const response = await client.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 1024,
  messages: [{ role: 'user', content: '...' }],
  surgeTags: { feature: 'summarize', customer_id: 'cust_abc123', plan: 'business' },
});
```

`surgeTags` is stripped from the request before it reaches the provider SDK.

The recognized tags are `feature`, `customer_id`, and `plan` — each is forwarded
as the matching field on the usage event. `plan` (spec §4.2) drives per-plan
cost attribution on the Surge dashboard. You can set any of them once for every
call via `configure({ defaultTags })`; a per-call `surgeTags` value wins on
conflict.

## Model overrides

Redirect calls to a different model than the call site declares — useful for
multi-tenant plan tiering (Starter → Haiku, Business → Opus) without touching
every call site:

```ts
// Global rule — applies to every call the SDK intercepts
configure({
  surgeApiUrl: '...',
  modelOverrides: {
    'claude-opus-4-6': 'claude-sonnet-4-6',  // all Opus calls become Sonnet
  },
});

// Per-call rule — wins over the global map
const response = await client.messages.create({
  model: 'claude-opus-4-6',                 // intent declared in code
  max_tokens: 1024,
  messages: [...],
  surgeModel: getTenantModel(tenantId),     // runtime tier resolution
  surgeTags: { feature: 'chat', customer_id: tenantId },
});
```

The dashboard logs both the requested and actual model on every override, plus
a "Savings from model overrides" card showing the cost delta over time.

`surgeModel` and `surgeTags` are both stripped from the request before it
reaches the provider SDK.

## Product event tracking

Beyond AI cost, you can record arbitrary product events (sign-ups, feature
usage, conversions) against the same product line and tenant model:

```ts
import { configure, track } from 'affixly-surge-sdk';

configure({
  surgeApiUrl: 'https://your-surge-backend-url',
  surgeApiKey: 'surge_sk_your_key_here',
  productLine: 'parse',
});

track('parse.repo.connected', 'github_username_or_user_id', {
  repo: 'owner/repo',
  language: 'python',
});
```

- `track(event, tenant, properties?)` POSTs `{ event, tenant, product, properties }`
  to `${surgeApiUrl}/api/track`, where `product` is the configured `productLine`.
- `tenant` is the stable identifier for the acting user/tenant; `properties` is
  optional arbitrary metadata.
- Same fire-and-forget guarantees as cost reporting: `track()` returns
  immediately, never throws, and drops the event silently if Surge is
  unreachable. If you call `track()` before `configure()`, it logs a warning and
  returns without sending.

### Reporting quota hits

`trackQuotaEvent()` is the helper the other Affixly products use to report
spend-ceiling / quota-limit hits (spec §1.5):

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
- It builds on `track()`, so it carries the same fire-and-forget guarantees.

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

## Capability matrix

Every wrapped method is **async** (returns a `Promise`) — the Node provider SDKs
have no synchronous surface, so there is no sync variant to wrap. Usage is
reported after the provider call resolves; the call's return value is never
changed.

| Provider | Import | Wrapped method | Streaming | What's captured |
|---|---|---|---|---|
| Anthropic | `import { anthropic } from 'affixly-surge-sdk'` | `messages.create()` | no | `input_tokens` / `output_tokens` from the response |
| Anthropic | | `messages.create({ stream: true })` | yes | usage accumulated from the stream (`Stream` shape) |
| Anthropic | | `messages.stream()` | yes | usage from the `MessageStream`; `.on()`, `.finalMessage()` and other helpers are preserved |
| OpenAI | `import { openai } from 'affixly-surge-sdk'` | `chat.completions.create()` | no | `prompt_tokens` / `completion_tokens` from the response |
| OpenAI | | `chat.completions.create({ stream: true })` | yes | usage from the final chunk (`stream_options.include_usage` forced on) |
| OpenAI | | `audio.transcriptions.create()` | no | audio duration → per-minute cost, reported with 0 tokens |
| Google Gemini | `import { gemini } from 'affixly-surge-sdk'` | `models.generateContent()` | no | token counts from `usageMetadata` |
| Google Gemini | | `models.generateContentStream()` | yes | cumulative usage from the final chunk |

Only these methods are intercepted. Every other property on a wrapped client
passes straight through to the provider SDK untouched.

**OpenAI streaming:** the SDK forces `stream_options.include_usage=true` on
streaming calls so the final chunk carries cumulative usage. Callers iterating
raw chunks will see one extra final chunk with `usage` populated — same shape as
if you'd set it yourself.

**OpenAI audio transcription:** `audio.transcriptions.create()` is billed per
minute of audio, not per token. Pass `response_format: 'verbose_json'` so the
response includes `duration`; without it the call is still reported, with 0
duration (cost 0). `surgeTags` / `surgeModel` are stripped the same way as on
token-based calls.

**Gemini wrapping surface:** only the `models` namespace is wrapped
(`generateContent`, `generateContentStream`). This package wraps
[`@google/genai`](https://www.npmjs.com/package/@google/genai) — the newer
Google GenAI SDK — exposed as `GoogleGenAI`:

```ts
import { gemini } from 'affixly-surge-sdk';
const client = new gemini.GoogleGenAI({ apiKey: 'AIza...' });
```

## Failure semantics

Two independent failure modes, kept separate by design:

- **Provider-call failure.** If the underlying provider/API call throws (rate
  limit, bad request, network error, …), that error propagates to your code
  **unchanged**. Surge never catches, wraps, retries, or swallows it, and
  reports nothing for a call that didn't return.
- **Reporting failure.** If sending the usage/track report to Surge fails
  (network error, non-2xx, timeout), it is isolated: logged at debug level (set
  `SURGE_SDK_DEBUG=1` to see it), never thrown, and the report is dropped. Your
  provider call and its result are unaffected.

To observe dropped reports without changing behavior, register a handler with
`setDiagnostics({ onReportError })` (see [Process lifecycle](#process-lifecycle)).

## Over-quota behavior

When your Surge event quota for the period is exceeded, the backend answers an
event report with the header `X-Surge-Quota: exceeded`. The SDK logs a single
`console.warn` per process and keeps running — over-quota events are dropped
server-side (they don't count against your plan) and nothing is thrown into your
code. This is the expected behavior at the free/over-quota boundary; upgrade the
plan to resume ingestion.

## Process lifecycle

Queued reports are drained automatically on normal process exit via a
`beforeExit` hook. That covers the common cases with no extra code:

- **Long-running servers** — fire-and-forget is fine. Reports flow out in the
  background while the process stays alive.
- **Short-lived scripts** — the `beforeExit` drain flushes queued reports before
  the process exits normally.
- **Serverless** (AWS Lambda, Vercel, Cloud Functions, …) — the platform may
  freeze the process between invocations before `beforeExit` runs, so drain
  explicitly at the end of the handler:

  ```ts
  import { flush } from 'affixly-surge-sdk';

  export const handler = async (event) => {
    const result = await doWork(event);
    await flush(2000); // drain queued reports; resolves false on timeout
    return result;
  };
  ```

- `flush(timeoutMs?) => Promise<boolean>` resolves `true` once the queue has
  drained, or `false` if `timeoutMs` elapses first. Omit `timeoutMs` to wait
  indefinitely.
- `setDiagnostics({ onReportError })` registers an opt-in handler called with the
  error whenever a report fails. It never changes failure behavior — Surge still
  never throws — it only lets you observe dropped reports (e.g. bump a metric).

See [`docs/getting-started.md`](docs/getting-started.md) for the full lifecycle
guide.

## Compatibility & versioning

- **Node:** `>= 18` (uses the global `fetch` API).
- **SemVer:** this package follows [Semantic Versioning](https://semver.org/).
- **Provider SDKs** are optional peer dependencies — install only the ones you
  use:

  | Peer dependency | Supported range |
  |---|---|
  | `@anthropic-ai/sdk` | `>=0.20` |
  | `openai` | `>=4` |
  | `@google/genai` | `>=1` |

- The package version is single-sourced in `package.json` and exposed at runtime
  via the `version` export (injected at build time, so there's no second copy to
  drift):

  ```ts
  import { version } from 'affixly-surge-sdk';
  console.log(version); // e.g. "0.7.0"
  ```

## Rolling back

To remove cost tracking from a code path, change the import back to the real
provider SDK **and remove any Surge-only options from the call sites**.
`surgeTags` and `surgeModel` are recognized only by the wrapper, which strips
them before calling the provider. Left on a bare provider client they are passed
through as unknown parameters, and the provider rejects the request.

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

## Documentation

Full guide: [`docs/getting-started.md`](docs/getting-started.md). Release history:
[`CHANGELOG.md`](CHANGELOG.md).

**Integrating with a coding agent?** Point Claude Code, Cursor, or Copilot at [`AGENTS.md`](AGENTS.md) — a step-by-step integration guide that has the agent confirm your product line and customer identifier before writing any code.

## License

MIT
