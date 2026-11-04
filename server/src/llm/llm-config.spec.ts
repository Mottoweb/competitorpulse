import { parseLlmConfig } from './llm-config';

const names = (env: NodeJS.ProcessEnv): string[] =>
  parseLlmConfig(env).providers.map((provider) => provider.name);

describe('parseLlmConfig', () => {
  it('puts DeepSeek first by default and skips providers without a key', () => {
    expect(
      names({ GROQ_API_KEY: 'g', OPENAI_API_KEY: 'o', DEEPSEEK_API_KEY: 'd' }),
    ).toEqual(['deepseek', 'openai', 'groq']);
  });

  it('treats an empty key as not set', () => {
    expect(names({ DEEPSEEK_API_KEY: '', OPENAI_API_KEY: 'o' })).toEqual([
      'openai',
    ]);
  });

  it('follows LLM_PROVIDER_ORDER, skipping listed providers without a key and ignoring unlisted ones', () => {
    expect(
      names({
        LLM_PROVIDER_ORDER: 'groq, anthropic ,deepseek',
        GROQ_API_KEY: 'g',
        DEEPSEEK_API_KEY: 'd',
        OPENAI_API_KEY: 'o',
      }),
    ).toEqual(['groq', 'deepseek']);
  });

  it('rejects an unknown or repeated provider in the order', () => {
    const key = { DEEPSEEK_API_KEY: 'd' };
    expect(() =>
      parseLlmConfig({ ...key, LLM_PROVIDER_ORDER: 'deepseek,nope' }),
    ).toThrow('LLM_PROVIDER_ORDER');
    expect(() =>
      parseLlmConfig({ ...key, LLM_PROVIDER_ORDER: 'deepseek,deepseek' }),
    ).toThrow('LLM_PROVIDER_ORDER');
  });

  it('refuses to start with no provider', () => {
    expect(() => parseLlmConfig({})).toThrow('No LLM provider');
    expect(() =>
      parseLlmConfig({ LLM_PROVIDER_ORDER: 'openai', DEEPSEEK_API_KEY: 'd' }),
    ).toThrow('No LLM provider');
  });

  it('uses table defaults, and the model and base URL overrides', () => {
    const [deepseek, openai] = parseLlmConfig({
      DEEPSEEK_API_KEY: 'd',
      OPENAI_API_KEY: 'o',
      OPENAI_MODEL: 'custom-model',
      OPENAI_BASE_URL: 'http://localhost:9/v1',
    }).providers;

    expect(deepseek).toMatchObject({
      apiKey: 'd',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
    });
    expect(openai).toMatchObject({
      apiKey: 'o',
      baseUrl: 'http://localhost:9/v1',
      model: 'custom-model',
    });
  });

  it('defaults the attempt cap to 3, or the provider count if higher', () => {
    expect(parseLlmConfig({ DEEPSEEK_API_KEY: 'd' }).maxAttempts).toBe(3);
    expect(
      parseLlmConfig({
        DEEPSEEK_API_KEY: 'd',
        OPENAI_API_KEY: 'o',
        GROQ_API_KEY: 'g',
        XAI_API_KEY: 'x',
      }).maxAttempts,
    ).toBe(4);
  });

  it('uses LLM_MAX_ATTEMPTS when set, and rejects invalid values without echoing secrets', () => {
    expect(
      parseLlmConfig({ DEEPSEEK_API_KEY: 'd', LLM_MAX_ATTEMPTS: '7' })
        .maxAttempts,
    ).toBe(7);

    const invalid = (): unknown =>
      parseLlmConfig({ DEEPSEEK_API_KEY: 'secret', LLM_MAX_ATTEMPTS: 'many' });
    expect(invalid).toThrow('LLM_MAX_ATTEMPTS');
    expect(invalid).not.toThrow('secret');
  });

  it('keeps the call timeout at 30s', () => {
    expect(parseLlmConfig({ DEEPSEEK_API_KEY: 'd' }).timeoutMs).toBe(30_000);
  });
});
