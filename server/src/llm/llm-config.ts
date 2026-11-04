import { z } from 'zod';
import {
  PROVIDER_DEFAULTS,
  PROVIDER_NAMES,
  type ProviderApi,
  type ProviderName,
  type TokenLimitParam,
} from './providers';

export interface LlmProvider {
  name: ProviderName;
  api: ProviderApi;
  apiKey: string;
  baseUrl: string;
  model: string;
  tokenLimitParam: TokenLimitParam;
}

export interface LlmConfig {
  providers: LlmProvider[];
  maxAttempts: number;
  timeoutMs: number;
  maxTokens: number;
  /** How long a provider is skipped after a timeout, 429 or 5xx. */
  failureCooldownMs: number;
  /** How long a provider is skipped after a bad key, no balance or wrong model. */
  unusableCooldownMs: number;
}

export const LLM_CONFIG = Symbol('LLM_CONFIG');

const DEFAULT_MAX_ATTEMPTS = 3;

const orderSchema = z
  .array(z.enum(PROVIDER_NAMES))
  .refine((names) => new Set(names).size === names.length);

const maxAttemptsSchema = z.coerce.number().int().positive();

function parseOrder(value: string | undefined): readonly ProviderName[] {
  if (value === undefined) {
    return PROVIDER_NAMES;
  }
  const result = orderSchema.safeParse(
    value.split(',').map((name) => name.trim()),
  );
  if (!result.success) {
    throw new Error('Invalid LLM configuration: LLM_PROVIDER_ORDER');
  }
  return result.data;
}

function parseMaxAttempts(
  value: string | undefined,
  providerCount: number,
): number {
  if (value === undefined) {
    return Math.max(DEFAULT_MAX_ATTEMPTS, providerCount);
  }
  const result = maxAttemptsSchema.safeParse(value);
  if (!result.success) {
    throw new Error('Invalid LLM configuration: LLM_MAX_ATTEMPTS');
  }
  return result.data;
}

export function parseLlmConfig(env: NodeJS.ProcessEnv): LlmConfig {
  // An empty value counts as unset, so a blank placeholder in .env changes nothing.
  const setting = (name: string): string | undefined => env[name] || undefined;

  const providers = parseOrder(setting('LLM_PROVIDER_ORDER')).flatMap(
    (name): LlmProvider[] => {
      const prefix = name.toUpperCase();
      const apiKey = setting(`${prefix}_API_KEY`);
      if (apiKey === undefined) {
        return [];
      }
      const defaults = PROVIDER_DEFAULTS[name];
      return [
        {
          ...defaults,
          name,
          apiKey,
          baseUrl: setting(`${prefix}_BASE_URL`) ?? defaults.baseUrl,
          model: setting(`${prefix}_MODEL`) ?? defaults.model,
        },
      ];
    },
  );
  if (providers.length === 0) {
    throw new Error(
      'No LLM provider is available: set an API key such as DEEPSEEK_API_KEY',
    );
  }

  return {
    providers,
    maxAttempts: parseMaxAttempts(setting('LLM_MAX_ATTEMPTS'), providers.length),
    timeoutMs: 30_000,
    // Generous for a short summary, because thinking models count their thinking here.
    maxTokens: 1000,
    failureCooldownMs: 30_000,
    unusableCooldownMs: 300_000,
  };
}
