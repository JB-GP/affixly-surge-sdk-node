import { getConfig } from '../config.js';
import { reportUsage } from '../reporter.js';
import { logger } from '../utils.js';
import type { Provider } from '../pricing.js';

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

export function instrumentMethod<TArgs extends object, TResult>(
  provider: Provider,
  realMethod: (args: TArgs) => Promise<TResult>,
  thisArg: unknown,
  extractUsage: UsageExtractor,
): (args: TArgs & SurgeOptions) => Promise<TResult> {
  return async (args: TArgs & SurgeOptions): Promise<TResult> => {
    const { surgeTags, surgeModel, ...rest } = args as TArgs & SurgeOptions;
    const cleanedArgs = rest as TArgs & { model?: string };

    const requestedModel = typeof cleanedArgs.model === 'string' ? cleanedArgs.model : 'unknown';
    const { actualModel, overriddenFrom } = resolveModel(requestedModel, surgeModel);
    if (actualModel !== requestedModel) {
      cleanedArgs.model = actualModel;
    }

    const response = await realMethod.call(thisArg, cleanedArgs as TArgs);

    try {
      const usage = extractUsage(response, cleanedArgs);
      if (usage) {
        reportUsage(
          provider,
          usage.model,
          usage.inputTokens,
          usage.outputTokens,
          surgeTags ?? null,
          overriddenFrom,
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
