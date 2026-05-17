export { configure, getConfig } from './config.js';
export type { SurgeConfig, ConfigureOptions } from './config.js';

import { Anthropic } from './providers/anthropic.js';
import { OpenAI } from './providers/openai.js';
import { GoogleGenAI } from './providers/gemini.js';

export const anthropic = { Anthropic };
export const openai = { OpenAI };
export const gemini = { GoogleGenAI };
