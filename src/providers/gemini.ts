import { instrumentMethod, getProp, toInt } from './wrap.js';
import { loadPeerModule } from './_load.js';

export interface GeminiModels {
  generateContent: (args: object) => Promise<unknown>;
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
