import { instrumentMethod, getProp, toInt } from './wrap.js';
import { loadPeerModule } from './_load.js';

export interface AnthropicMessages {
  create: (args: object) => Promise<unknown>;
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

export function wrapAnthropicClient<T extends AnthropicLike>(client: T): T {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'messages') {
        const messages = Reflect.get(target, prop, receiver) as AnthropicMessages;
        return new Proxy(messages, {
          get(msgTarget, msgProp, msgReceiver) {
            if (msgProp === 'create') {
              const realCreate = (msgTarget.create as (args: object) => Promise<unknown>).bind(
                msgTarget,
              );
              return instrumentMethod(
                'anthropic',
                realCreate,
                msgTarget,
                extractAnthropicUsage,
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
