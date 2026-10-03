# Changelog

All notable changes to `affixly-surge-sdk` (Node) are documented here. This
project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed
- `flush(timeoutMs)` no longer holds the process open after it resolves. The
  deadline timer it raced against the in-flight sends was never cleared, so a
  short-lived script that awaited `flush(30000)` stayed alive for the full 30s
  after its reports had already been sent. The timer is now cleared when the
  sends settle and `unref()`'d so it can never keep the event loop alive.
- `trackQuotaEvent()` now sends the event's top-level `product` as its
  `productLine` argument instead of always using the `productLine` from
  `configure()`. Falls back to the configured value when it is empty.

## [0.7.0] — 2026-10-01

### Added

- `plan` usage tag (spec §4.2): set it in `configure({ defaultTags })` or a
  per-call `surgeTags` object; forwarded as the event's `plan` field for
  per-plan cost attribution.
- `trackQuotaEvent(kind, productLine, customerId, plan?, fields?)` — helper for
  reporting `quota.ceiling_hit` / `quota.limit_hit` product events (spec §1.5).
- `flush(timeoutMs?) => Promise<boolean>` — await until queued usage/track
  reports have drained (or `timeoutMs` elapses); for serverless invocations and
  short-lived scripts where the automatic `beforeExit` drain may not run.
- `setDiagnostics({ onReportError })` — opt-in observer for failed reports. It
  never changes failure behavior; Surge still never throws into caller code.
- `version` export — the package version, single-sourced from `package.json`
  and injected at build time.

### Changed

- `X-Surge-Quota: exceeded` responses now emit a single `console.warn` per
  process instead of being silent. Events are dropped server-side (they don't
  count against the plan) and nothing is thrown.

### Docs

- Added a capability matrix (provider × wrapped method × streaming), including
  OpenAI audio transcription.
- Documented provider-call failure (propagates unchanged) separately from
  reporting failure (isolated, debug-logged, never thrown, observable via
  `setDiagnostics()`).
- Added a process-lifecycle section (short-lived scripts, long-running servers,
  serverless with `await flush()`).
- Added a compatibility & versioning section (SemVer, Node >=18, optional
  provider peer-dependency ranges, the `version` export).
- Fixed the rollback guidance: reverting to the bare provider SDK also requires
  removing `surgeTags` / `surgeModel` from the call sites.

## [0.6.0]

- Product event tracking via `track()`.

## [0.5.0]

- OpenAI audio transcription tracking (`audio.transcriptions.create()`).

## [0.4.0]

- Fixed streaming usage capture for helper-based consumption
  (`messages.stream()` drained via `.finalMessage()` / `.on()`).

## [0.3.0]

- Streaming token tracking for all providers.

## [0.2.0]

- Pricing match fix; model overrides (`surgeModel` option + `modelOverrides`).
