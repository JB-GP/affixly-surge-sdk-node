import { instrumentMethod, getProp, toInt } from './wrap.js';
import { loadPeerModule } from './_load.js';

export interface OpenAICompletions {
  create: (args: object) => Promise<unknown>;
  [k: string]: unknown;
}

export interface OpenAIChat {
  completions: OpenAICompletions;
  [k: string]: unknown;
}

export interface OpenAILike {
  chat: OpenAIChat;
  [k: string]: unknown;
}

function extractOpenAIUsage(
  response: unknown,
): { model: string; inputTokens: number; outputTokens: number } | null {
  const model = (getProp(response, 'model') as string) ?? 'unknown';
  const usage = getProp(response, 'usage');
  if (!usage) return null;
  return {
    model,
    inputTokens: toInt(getProp(usage, 'prompt_tokens')),
    outputTokens: toInt(getProp(usage, 'completion_tokens')),
  };
}

export function wrapOpenAIClient<T extends OpenAILike>(client: T): T {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'chat') {
        const chat = Reflect.get(target, prop, receiver) as OpenAIChat;
        return new Proxy(chat, {
          get(chatTarget, chatProp, chatReceiver) {
            if (chatProp === 'completions') {
              const completions = Reflect.get(
                chatTarget,
                chatProp,
                chatReceiver,
              ) as OpenAICompletions;
              return new Proxy(completions, {
                get(compTarget, compProp, compReceiver) {
                  if (compProp === 'create') {
                    const realCreate = (
                      compTarget.create as (args: object) => Promise<unknown>
                    ).bind(compTarget);
                    return instrumentMethod(
                      'openai',
                      realCreate,
                      compTarget,
                      extractOpenAIUsage,
                    );
                  }
                  return Reflect.get(compTarget, compProp, compReceiver);
                },
              });
            }
            return Reflect.get(chatTarget, chatProp, chatReceiver);
          },
        });
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as T;
}

type OpenAICtor = new (...args: unknown[]) => OpenAILike;

function getRealOpenAI(): OpenAICtor {
  const mod = loadPeerModule('openai', 'npm install openai') as {
    OpenAI?: OpenAICtor;
    default?: OpenAICtor;
  };
  const Ctor = mod.OpenAI ?? mod.default;
  if (!Ctor) throw new Error('Could not find OpenAI class in openai package');
  return Ctor;
}

export const OpenAI = new Proxy(function () {} as unknown as OpenAICtor, {
  construct(_target, args) {
    const Real = getRealOpenAI();
    return wrapOpenAIClient(new Real(...args));
  },
}) as OpenAICtor;
