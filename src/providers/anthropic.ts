import {
  instrumentMethod,
  instrumentStreamMethod,
  getProp,
  toInt,
  type StreamCollector,
  type StreamUsageState,
} from './wrap.js';
import { loadPeerModule } from './_load.js';

export interface AnthropicMessages {
  create: (args: object) => Promise<unknown>;
  stream?: (args: object) => unknown;
  [k: string]: unknown;
}

export interface AnthropicLike {
  messages: AnthropicMessages;
  [k: string]: unknown;
}

function extractAnthropicUsage(
  response: unknown,
): { model: string; inputTokens: number; outputTokens: number } | null {
  const model = (getProp(response, 'model') as string) ?? 'unknown';
  const usage = getProp(response, 'usage');
  if (!usage) return null;
  return {
    model,
    inputTokens: toInt(getProp(usage, 'input_tokens')),
    outputTokens: toInt(getProp(usage, 'output_tokens')),
  };
}

/**
 * Stream collector for Anthropic events. The Anthropic streaming API emits:
 *   - message_start: contains `message.model` + `message.usage.input_tokens`
 *     (output_tokens is 0 here)
 *   - message_delta: contains cumulative `usage.output_tokens`
 *   - other events: ignored for usage purposes
 *
 * We pluck whichever fields are present on whichever event we see, which
 * makes this resilient to both the lower-level `Stream<MessageStreamEvent>`
 * returned by `messages.create({stream: true})` and the higher-level
 * `MessageStream` from `messages.stream({...})`.
 */
const anthropicStreamCollector: StreamCollector<unknown> = {
  init(args: object): StreamUsageState {
    const model = getProp(args, 'model');
    return {
      model: typeof model === 'string' ? model : 'unknown',
      inputTokens: 0,
      outputTokens: 0,
    };
  },
  onChunk(state, event) {
    const message = getProp(event, 'message');
    if (message && typeof message === 'object') {
      const mdl = getProp(message, 'model');
      if (typeof mdl === 'string') state.model = mdl;
      const usage = getProp(message, 'usage');
      if (usage) {
        const inp = toInt(getProp(usage, 'input_tokens'));
        if (inp > 0) state.inputTokens = inp;
        const out = toInt(getProp(usage, 'output_tokens'));
        if (out > 0) state.outputTokens = out;
      }
    }
    const usageOnEvent = getProp(event, 'usage');
    if (usageOnEvent) {
      const inp = toInt(getProp(usageOnEvent, 'input_tokens'));
      if (inp > 0) state.inputTokens = inp;
      const out = toInt(getProp(usageOnEvent, 'output_tokens'));
      if (out > 0) state.outputTokens = out;
    }
  },
  // Fallback for `messages.stream()` consumed via `.on('text')` + an awaited
  // `finalMessage()` (no async iteration): pull model + usage off the
  // accumulated Message so we still report instead of dropping the call.
  finalize(state, finalMessage) {
    const mdl = getProp(finalMessage, 'model');
    if (typeof mdl === 'string') state.model = mdl;
    const usage = getProp(finalMessage, 'usage');
    if (usage) {
      const inp = toInt(getProp(usage, 'input_tokens'));
      if (inp > 0) state.inputTokens = inp;
      const out = toInt(getProp(usage, 'output_tokens'));
      if (out > 0) state.outputTokens = out;
    }
  },
  finalizeMethods: ['finalMessage'],
};

export function wrapAnthropicClient<T extends AnthropicLike>(client: T): T {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'messages') {
        const messages = Reflect.get(target, prop, receiver) as AnthropicMessages;
        return new Proxy(messages, {
          get(msgTarget, msgProp, msgReceiver) {
            if (msgProp === 'create') {
              const realCreate = (
                msgTarget.create as (args: object) => Promise<unknown>
              ).bind(msgTarget);
              const trackedNonStream = instrumentMethod(
                'anthropic',
                realCreate,
                msgTarget,
                extractAnthropicUsage,
              );
              const trackedStream = instrumentStreamMethod<
                object,
                unknown,
                AsyncIterable<unknown>
              >(
                'anthropic',
                realCreate as (args: object) => Promise<AsyncIterable<unknown>>,
                msgTarget,
                anthropicStreamCollector,
              );
              // Route on `stream: true` so the same `create` method handles
              // both shapes the way the upstream SDK does.
              return (args: object & { stream?: boolean }) =>
                args && args.stream === true ? trackedStream(args) : trackedNonStream(args);
            }
            if (msgProp === 'stream' && typeof msgTarget.stream === 'function') {
              const realStream = (msgTarget.stream as (args: object) => unknown).bind(msgTarget);
              return instrumentStreamMethod<object, unknown, AsyncIterable<unknown>>(
                'anthropic',
                realStream as (args: object) => Promise<AsyncIterable<unknown>>,
                msgTarget,
                anthropicStreamCollector,
              );
            }
            return Reflect.get(msgTarget, msgProp, msgReceiver);
          },
        });
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as T;
}

type AnthropicCtor = new (...args: unknown[]) => AnthropicLike;

function getRealAnthropic(): AnthropicCtor {
  const mod = loadPeerModule('@anthropic-ai/sdk', 'npm install @anthropic-ai/sdk') as {
    Anthropic?: AnthropicCtor;
    default?: AnthropicCtor;
  };
  const Ctor = mod.Anthropic ?? mod.default;
  if (!Ctor) throw new Error('Could not find Anthropic class in @anthropic-ai/sdk');
  return Ctor;
}

export const Anthropic = new Proxy(function () {} as unknown as AnthropicCtor, {
  construct(_target, args) {
    const Real = getRealAnthropic();
    return wrapAnthropicClient(new Real(...args));
  },
}) as AnthropicCtor;
