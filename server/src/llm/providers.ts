export const PROVIDER_NAMES = [
  'deepseek',
  'openai',
  'anthropic',
  'gemini',
  'mistral',
  'groq',
  'xai',
  'mock',
] as const;

export type ProviderName = (typeof PROVIDER_NAMES)[number];

export type ProviderApi = 'openai_compatible' | 'anthropic';

/** OpenAI's newer models reject `max_tokens` with a 400. */
export type TokenLimitParam = 'max_tokens' | 'max_completion_tokens';

export interface ProviderDefaults {
  api: ProviderApi;
  baseUrl: string;
  model: string;
  tokenLimitParam: TokenLimitParam;
}

export const PROVIDER_DEFAULTS: Record<ProviderName, ProviderDefaults> = {
  deepseek: {
    api: 'openai_compatible',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    tokenLimitParam: 'max_tokens',
  },
  openai: {
    api: 'openai_compatible',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.4-mini',
    tokenLimitParam: 'max_completion_tokens',
  },
  anthropic: {
    api: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-opus-5-5',
    tokenLimitParam: 'max_tokens',
  },
  gemini: {
    api: 'openai_compatible',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    model: 'gemini-3.8-flash',
    tokenLimitParam: 'max_tokens',
  },
  mistral: {
    api: 'openai_compatible',
    baseUrl: 'https://api.mistral.ai/v1',
    model: 'mistral-small-latest',
    tokenLimitParam: 'max_tokens',
  },
  groq: {
    api: 'openai_compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    tokenLimitParam: 'max_tokens',
  },
  xai: {
    api: 'openai_compatible',
    baseUrl: 'https://api.x.ai/v1',
    model: 'grok-4',
    tokenLimitParam: 'max_tokens',
  },
  // The stand-in server from files/mock-llm. Last by default, so it only runs
  // alone or as the final fallback.
  mock: {
    api: 'openai_compatible',
    baseUrl: 'http://localhost:4001/v1',
    model: 'mock-llm',
    tokenLimitParam: 'max_tokens',
  },
};
