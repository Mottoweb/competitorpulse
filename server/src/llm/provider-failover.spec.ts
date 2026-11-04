import { parseLlmConfig } from './llm-config';
import { ProviderFailover } from './provider-failover';

const config = {
  ...parseLlmConfig({
    DEEPSEEK_API_KEY: 'd',
    OPENAI_API_KEY: 'o',
    GROQ_API_KEY: 'g',
  }),
  failureCooldownMs: 1_000,
  unusableCooldownMs: 10_000,
};

describe('ProviderFailover', () => {
  let time: number;
  let failover: ProviderFailover;
  const selected = (attempt: number): string => failover.select(attempt).name;
  const provider = (index: number) => {
    const found = config.providers[index];
    if (found === undefined) {
      throw new Error('No such provider');
    }
    return found;
  };

  beforeEach(() => {
    time = 0;
    failover = new ProviderFailover(config, () => time);
  });

  it('cycles through the providers by attempt number', () => {
    expect([1, 2, 3, 4, 5].map(selected)).toEqual([
      'deepseek',
      'openai',
      'groq',
      'deepseek',
      'openai',
    ]);
  });

  it('skips a provider that just failed, until its cooldown ends', () => {
    failover.recordFailure(provider(0), 'transient');
    expect(selected(1)).toBe('openai');

    time = 999;
    expect(selected(1)).toBe('openai');

    time = 1_000;
    expect(selected(1)).toBe('deepseek');
  });

  it('cools down longer for a bad key or balance', () => {
    failover.recordFailure(provider(0), 'provider_unusable');

    time = 9_999;
    expect(selected(1)).toBe('openai');

    time = 10_000;
    expect(selected(1)).toBe('deepseek');
  });

  it('does not cool down a provider when the request itself was at fault', () => {
    failover.recordFailure(provider(0), 'bad_request');

    expect(selected(1)).toBe('deepseek');
  });

  it('falls back to the attempt number when every provider is cooling down', () => {
    [0, 1, 2].forEach((index) => {
      failover.recordFailure(provider(index), 'transient');
    });

    expect(selected(2)).toBe('openai');
  });
});
