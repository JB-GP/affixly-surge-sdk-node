import {
  instrumentMethod,
  instrumentStreamMethod,
  getProp,
  toInt,
  type StreamCollector,
  type StreamUsageState,
} from './wrap.js';
import { loadPeerModule } from './_load.js';

export interface GeminiModels {
  generateContent: (args: object) => Promise<unknown>;
  generateContentStream?: (args: object) => unknown;
  [k: string]: unknown;
}

export interface GeminiLike {
  models: GeminiModels;
  [k: string]: unknown;
}

function normalizeModel(value: unknown): string {
  let model = typeof value === 'string' ? value : 'gemini-unknown';
  if (model.startsWith('models/')) model = model.slice('models/'.length);
  return model;
}

function extractGeminiUsage(
  response: unknown,
  args: object,
): { model: string; inputTokens: number; outputTokens: number } | null {
  const meta = getProp(response, 'usageMetadata');
  if (!meta) return null;
  const model = normalizeModel(getProp(args, 'model') ?? getProp(response, 'model'));
  return {
    model,
    inputTokens: toInt(getProp(meta, 'promptTokenCount')),
    outputTokens: toInt(getProp(meta, 'candidatesTokenCount')),
  };
}

/**
 * Gemini streams emit a sequence of GenerateContentResponse chunks. Token
 * counts on usageMetadata are cumulative — the final chunk carries the
 * authoritative totals. Model isn't always present on chunks; we seed from
 * the request args via init() and refresh whenever a chunk does include it.
 */
const geminiStreamCollector: StreamCollector<unknown> = {
  init(args: object): StreamUsageState {
    return {
      model: normalizeModel(getProp(args, 'model')),
      inputTokens: 0,
      outputTokens: 0,
    };
  },
  onChunk(state, chunk) {
    const mdl = getProp(chunk, 'model');
    if (typeof mdl === 'string') state.model = normalizeModel(mdl);
    const meta = getProp(chunk, 'usageMetadata');
    if (meta) {
      const inp = toInt(getProp(meta, 'promptTokenCount'));
      if (inp > 0) state.inputTokens = inp;
      const out = toInt(getProp(meta, 'candidatesTokenCount'));
      if (out > 0) state.outputTokens = out;
    }
  },
};

export function wrapGeminiClient<T extends GeminiLike>(client: T): T {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'models') {
        const models = Reflect.get(target, prop, receiver) as GeminiModels;
        return new Proxy(models, {
          get(modelsTarget, modelsProp, modelsReceiver) {
            if (modelsProp === 'generateContent') {
              const realGen = (
                modelsTarget.generateContent as (args: object) => Promise<unknown>
              ).bind(modelsTarget);
              return instrumentMethod(
                'gemini',
                realGen,
                modelsTarget,
                extractGeminiUsage,
              );
            }
            if (
              modelsProp === 'generateContentStream' &&
              typeof modelsTarget.generateContentStream === 'function'
            ) {
              const realStream = (
                modelsTarget.generateContentStream as (args: object) => unknown
              ).bind(modelsTarget);
              return instrumentStreamMethod<object, unknown, AsyncIterable<unknown>>(
                'gemini',
                realStream as (args: object) => Promise<AsyncIterable<unknown>>,
                modelsTarget,
                geminiStreamCollector,
              );
            }
            return Reflect.get(modelsTarget, modelsProp, modelsReceiver);
          },
        });
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as T;
}

type GeminiCtor = new (...args: unknown[]) => GeminiLike;

function getRealGoogleGenAI(): GeminiCtor {
  const mod = loadPeerModule('@google/genai', 'npm install @google/genai') as {
    GoogleGenAI?: GeminiCtor;
    default?: GeminiCtor;
  };
  const Ctor = mod.GoogleGenAI ?? mod.default;
  if (!Ctor) throw new Error('Could not find GoogleGenAI class in @google/genai');
  return Ctor;
}

export const GoogleGenAI = new Proxy(function () {} as unknown as GeminiCtor, {
  construct(_target, args) {
    const Real = getRealGoogleGenAI();
    return wrapGeminiClient(new Real(...args));
  },
}) as GeminiCtor;
