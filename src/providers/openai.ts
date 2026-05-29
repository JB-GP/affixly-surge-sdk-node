import {
  instrumentMethod,
  instrumentStreamMethod,
  instrumentAudioMethod,
  getProp,
  toInt,
  type StreamCollector,
  type StreamUsageState,
} from './wrap.js';
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

/**
 * Stream collector for OpenAI chunks. With stream_options.include_usage=true
 * (which we inject — see preCall below), the very last chunk carries the
 * cumulative `usage` object. Earlier chunks carry only `model` + delta
 * content, so we keep updating model from every chunk that has it and
 * only seize usage when it appears.
 */
const openaiStreamCollector: StreamCollector<unknown> = {
  init(args: object): StreamUsageState {
    const model = getProp(args, 'model');
    return {
      model: typeof model === 'string' ? model : 'unknown',
      inputTokens: 0,
      outputTokens: 0,
    };
  },
  onChunk(state, chunk) {
    const mdl = getProp(chunk, 'model');
    if (typeof mdl === 'string') state.model = mdl;
    const usage = getProp(chunk, 'usage');
    if (usage) {
      const inp = toInt(getProp(usage, 'prompt_tokens'));
      if (inp > 0) state.inputTokens = inp;
      const out = toInt(getProp(usage, 'completion_tokens'));
      if (out > 0) state.outputTokens = out;
    }
  },
};

/**
 * Inject `stream_options.include_usage=true` so the OpenAI Stream emits a
 * final chunk carrying cumulative usage. Preserves any other stream_options
 * the caller set; flips include_usage to true even if the caller set it to
 * false (they opted into Surge by using the wrapper).
 */
function ensureIncludeUsage(args: object): void {
  const a = args as { stream_options?: Record<string, unknown> };
  a.stream_options = { ...(a.stream_options ?? {}), include_usage: true };
}

/**
 * Pull model + audio duration off a transcription/translation response. The
 * `duration` field (seconds) is only present when the caller sets
 * response_format="verbose_json"; without it we report the request with 0
 * duration (cost 0) so the call is still visible.
 */
function extractTranscriptionAudio(
  response: unknown,
  args: object,
): { model: string; audioSeconds: number } {
  const model = (getProp(args, 'model') as string) ?? 'unknown';
  const duration = getProp(response, 'duration');
  return {
    model,
    audioSeconds: typeof duration === 'number' ? duration : 0,
  };
}

export function wrapOpenAIClient<T extends OpenAILike>(client: T): T {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'audio') {
        const audio = Reflect.get(target, prop, receiver) as Record<string, unknown>;
        return new Proxy(audio, {
          get(audioTarget, audioProp, audioReceiver) {
            if (audioProp === 'transcriptions') {
              const transcriptions = Reflect.get(
                audioTarget,
                audioProp,
                audioReceiver,
              ) as { create: (args: object) => Promise<unknown>; [k: string]: unknown };
              return new Proxy(transcriptions, {
                get(tTarget, tProp, tReceiver) {
                  if (tProp === 'create') {
                    const realCreate = (
                      tTarget.create as (args: object) => Promise<unknown>
                    ).bind(tTarget);
                    return instrumentAudioMethod(
                      'openai',
                      realCreate,
                      tTarget,
                      extractTranscriptionAudio,
                    );
                  }
                  return Reflect.get(tTarget, tProp, tReceiver);
                },
              });
            }
            return Reflect.get(audioTarget, audioProp, audioReceiver);
          },
        });
      }
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
                    const trackedNonStream = instrumentMethod(
                      'openai',
                      realCreate,
                      compTarget,
                      extractOpenAIUsage,
                    );
                    const trackedStream = instrumentStreamMethod<
                      object,
                      unknown,
                      AsyncIterable<unknown>
                    >(
                      'openai',
                      realCreate as (args: object) => Promise<AsyncIterable<unknown>>,
                      compTarget,
                      openaiStreamCollector,
                      ensureIncludeUsage,
                    );
                    return (args: object & { stream?: boolean }) =>
                      args && args.stream === true ? trackedStream(args) : trackedNonStream(args);
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
