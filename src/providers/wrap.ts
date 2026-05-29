import { getConfig } from '../config.js';
import { reportUsage } from '../reporter.js';
import { logger } from '../utils.js';
import { estimateAudioCost, type Provider } from '../pricing.js';

export interface SurgeOptions {
  surgeTags?: Record<string, string>;
  surgeModel?: string;
}

interface UsageExtractor {
  (response: unknown, args: object): {
    model: string;
    inputTokens: number;
    outputTokens: number;
  } | null;
}

function resolveModel(
  requestedModel: string,
  surgeModel: string | undefined,
): { actualModel: string; overriddenFrom: string | undefined } {
  if (surgeModel && surgeModel !== requestedModel) {
    logger.debug(`Model overridden: ${requestedModel} -> ${surgeModel} (per-request)`);
    return { actualModel: surgeModel, overriddenFrom: requestedModel };
  }

  const overrides = getConfig().modelOverrides ?? {};
  const mapped = overrides[requestedModel];
  if (mapped && mapped !== requestedModel) {
    logger.debug(`Model overridden: ${requestedModel} -> ${mapped} (global rule)`);
    return { actualModel: mapped, overriddenFrom: requestedModel };
  }

  return { actualModel: requestedModel, overriddenFrom: undefined };
}

/**
 * Apply Surge-specific kwargs (surgeTags, surgeModel) to the call args.
 * Strips them from the args passed to the real provider and applies the
 * model override if one fires.
 *
 * Returns the cleaned args + the metadata our reporter needs at the end.
 */
function prepareCallArgs<TArgs extends object>(
  args: TArgs & SurgeOptions,
): {
  cleanedArgs: TArgs & { model?: string };
  surgeTags: Record<string, string> | null;
  overriddenFrom: string | undefined;
} {
  const { surgeTags, surgeModel, ...rest } = args as TArgs & SurgeOptions;
  const cleanedArgs = rest as TArgs & { model?: string };
  const requestedModel = typeof cleanedArgs.model === 'string' ? cleanedArgs.model : 'unknown';
  const { actualModel, overriddenFrom } = resolveModel(requestedModel, surgeModel);
  if (actualModel !== requestedModel) {
    cleanedArgs.model = actualModel;
  }
  return { cleanedArgs, surgeTags: surgeTags ?? null, overriddenFrom };
}

export function instrumentMethod<TArgs extends object, TResult>(
  provider: Provider,
  realMethod: (args: TArgs) => Promise<TResult>,
  thisArg: unknown,
  extractUsage: UsageExtractor,
): (args: TArgs & SurgeOptions) => Promise<TResult> {
  return async (args: TArgs & SurgeOptions): Promise<TResult> => {
    const { cleanedArgs, surgeTags, overriddenFrom } = prepareCallArgs(args);

    const response = await realMethod.call(thisArg, cleanedArgs as TArgs);

    try {
      const usage = extractUsage(response, cleanedArgs);
      if (usage) {
        reportUsage(
          provider,
          usage.model,
          usage.inputTokens,
          usage.outputTokens,
          surgeTags,
          overriddenFrom,
        );
      }
    } catch (err) {
      logger.debug(`Failed to extract usage from ${provider} response`, err);
    }

    return response;
  };
}

/**
 * Audio counterpart to instrumentMethod, for transcription/translation calls
 * that bill per audio-minute instead of per token. The extractor pulls the
 * model + audio duration (seconds) off the response; cost is computed from the
 * per-minute audio pricing table and reported with 0 tokens.
 */
export function instrumentAudioMethod<TArgs extends object, TResult>(
  provider: Provider,
  realMethod: (args: TArgs) => Promise<TResult>,
  thisArg: unknown,
  extractAudio: (response: unknown, args: object) => { model: string; audioSeconds: number } | null,
): (args: TArgs & SurgeOptions) => Promise<TResult> {
  return async (args: TArgs & SurgeOptions): Promise<TResult> => {
    const { cleanedArgs, surgeTags } = prepareCallArgs(args);

    const response = await realMethod.call(thisArg, cleanedArgs as TArgs);

    try {
      const info = extractAudio(response, cleanedArgs);
      if (info) {
        const cost = estimateAudioCost(provider, info.model, info.audioSeconds);
        reportUsage(provider, info.model, 0, 0, surgeTags, undefined, cost);
      }
    } catch (err) {
      logger.debug(`Failed to extract audio usage from ${provider} response`, err);
    }

    return response;
  };
}

/**
 * Streaming counterpart to instrumentMethod.
 *
 * The real method must return an `AsyncIterable<TChunk>` (or a Promise of
 * one). We wrap it with a Proxy that yields each chunk to the caller while
 * a `StreamCollector` accumulates the running totals from those chunks.
 * When iteration completes — successfully OR via early break / exception —
 * the collected usage is reported exactly once.
 *
 * The Proxy preserves all helper methods on the original stream object
 * (Anthropic's MessageStream has `.finalMessage()`, `.on()`, etc.); only
 * `[Symbol.asyncIterator]` is intercepted.
 */
export interface StreamUsageState {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface StreamCollector<TChunk> {
  /** Build the initial accumulator state. Called once at stream start. */
  init(args: object): StreamUsageState;
  /** Mutate the state with info from a chunk. */
  onChunk(state: StreamUsageState, chunk: TChunk): void;
  /**
   * Optional fallback: extract usage from the value a terminal helper method
   * resolves to (e.g. Anthropic's `finalMessage()`). Used for callers that
   * drain the stream via helpers / event emitters rather than async iteration,
   * which never routes chunks through `onChunk`.
   */
  finalize?(state: StreamUsageState, finalValue: unknown): void;
  /**
   * Names of terminal helper methods whose resolved value should be handed to
   * `finalize` (e.g. ['finalMessage']). Only consulted when `finalize` is set.
   */
  finalizeMethods?: string[];
}

function stateIncomplete(state: StreamUsageState): boolean {
  return state.model === 'unknown' || (state.inputTokens === 0 && state.outputTokens === 0);
}

export function instrumentStreamMethod<
  TArgs extends object,
  TChunk,
  TStream extends AsyncIterable<TChunk>,
>(
  provider: Provider,
  realMethod: (args: TArgs) => Promise<TStream> | TStream,
  thisArg: unknown,
  collector: StreamCollector<TChunk>,
  preCall?: (args: TArgs & { model?: string }) => void,
): (args: TArgs & SurgeOptions) => Promise<TStream> {
  return async (args: TArgs & SurgeOptions): Promise<TStream> => {
    const { cleanedArgs, surgeTags, overriddenFrom } = prepareCallArgs(args);
    if (preCall) preCall(cleanedArgs);

    const realStream = await Promise.resolve(realMethod.call(thisArg, cleanedArgs as TArgs));

    const state = collector.init(cleanedArgs);
    let reported = false;
    const report = () => {
      if (reported) return;
      reported = true;
      try {
        if (state.inputTokens > 0 || state.outputTokens > 0) {
          reportUsage(
            provider,
            state.model,
            state.inputTokens,
            state.outputTokens,
            surgeTags,
            overriddenFrom,
          );
        }
      } catch (err) {
        logger.debug(`Failed to report ${provider} streaming usage`, err);
      }
    };

    const trackedIterator = async function* (): AsyncGenerator<TChunk> {
      try {
        for await (const chunk of realStream as AsyncIterable<TChunk>) {
          try {
            collector.onChunk(state, chunk);
          } catch (err) {
            logger.debug(`Failed to collect ${provider} stream chunk`, err);
          }
          yield chunk;
        }
      } finally {
        // try/finally so early break or thrown errors still report whatever
        // we managed to collect — partial usage is correct usage.
        report();
      }
    };

    const finalizeMethods = collector.finalize ? (collector.finalizeMethods ?? []) : [];

    return new Proxy(realStream as object, {
      get(target, prop, receiver) {
        if (prop === Symbol.asyncIterator) {
          return () => trackedIterator();
        }
        // Helper-based consumption (e.g. `.on('text')` + `await finalMessage()`)
        // bypasses the async iterator, so chunks never reach `onChunk`. Hook
        // the terminal helper to recover usage from its accumulated result.
        if (typeof prop === 'string' && finalizeMethods.includes(prop)) {
          const realFn = Reflect.get(target, prop, receiver);
          if (typeof realFn === 'function') {
            return async (...callArgs: unknown[]) => {
              const result = await realFn.apply(target, callArgs);
              try {
                if (stateIncomplete(state)) collector.finalize!(state, result);
              } catch (err) {
                logger.debug(`Failed to finalize ${provider} stream usage`, err);
              }
              report();
              return result;
            };
          }
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as TStream;
  };
}

export function getProp(obj: unknown, key: string): unknown {
  if (obj && typeof obj === 'object' && key in obj) {
    return (obj as Record<string, unknown>)[key];
  }
  return undefined;
}

export function toInt(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.trunc(n);
}
