import { reportUsage } from '../reporter.js';
import { logger } from '../utils.js';
import type { Provider } from '../pricing.js';

export interface SurgeOptions {
  surgeTags?: Record<string, string>;
}

interface UsageExtractor {
  (response: unknown, args: object): {
    model: string;
    inputTokens: number;
    outputTokens: number;
  } | null;
}

export function instrumentMethod<TArgs extends object, TResult>(
  provider: Provider,
  realMethod: (args: TArgs) => Promise<TResult>,
  thisArg: unknown,
  extractUsage: UsageExtractor,
): (args: TArgs & SurgeOptions) => Promise<TResult> {
  return async (args: TArgs & SurgeOptions): Promise<TResult> => {
    const { surgeTags, ...rest } = args as TArgs & SurgeOptions;
    const cleanedArgs = rest as TArgs;

    const response = await realMethod.call(thisArg, cleanedArgs);

    try {
      const usage = extractUsage(response, cleanedArgs);
      if (usage) {
        reportUsage(
          provider,
          usage.model,
          usage.inputTokens,
          usage.outputTokens,
          surgeTags ?? null,
        );
      }
    } catch (err) {
      logger.debug(`Failed to extract usage from ${provider} response`, err);
    }

    return response;
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
