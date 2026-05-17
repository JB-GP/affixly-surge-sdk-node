import { validateUrl } from './utils.js';

export interface SurgeConfig {
  surgeApiUrl: string | null;
  surgeApiKey: string | null;
  productLine: string | null;
  defaultTags: Record<string, string>;
}

export interface ConfigureOptions {
  surgeApiUrl?: string;
  surgeApiKey?: string;
  productLine?: string;
  defaultTags?: Record<string, string>;
}

function envFallbacks(): SurgeConfig {
  return {
    surgeApiUrl: process.env.SURGE_API_URL ?? null,
    surgeApiKey: process.env.SURGE_SDK_KEY ?? null,
    productLine: process.env.SURGE_PRODUCT_LINE ?? null,
    defaultTags: {},
  };
}

let currentConfig: SurgeConfig = envFallbacks();

export function configure(options: ConfigureOptions = {}): void {
  const next: SurgeConfig = {
    surgeApiUrl:
      options.surgeApiUrl !== undefined ? options.surgeApiUrl : currentConfig.surgeApiUrl,
    surgeApiKey:
      options.surgeApiKey !== undefined ? options.surgeApiKey : currentConfig.surgeApiKey,
    productLine:
      options.productLine !== undefined ? options.productLine : currentConfig.productLine,
    defaultTags:
      options.defaultTags !== undefined
        ? { ...options.defaultTags }
        : currentConfig.defaultTags,
  };
  currentConfig = next;

  if (options.surgeApiUrl !== undefined) {
    validateUrl(next.surgeApiUrl);
  }
}

export function getConfig(): SurgeConfig {
  return currentConfig;
}

export function _resetConfigForTests(): void {
  currentConfig = envFallbacks();
}
