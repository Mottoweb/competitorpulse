import { parseLlmConfig } from '../llm/llm-config';
import { parseSummarizerConfig } from './summarizer-config';

describe('parseSummarizerConfig', () => {
  it('uses the planned defaults', () => {
    expect(parseSummarizerConfig({}, 3)).toEqual({
      checkIntervalSeconds: 15,
      concurrency: 5,
      claimRetrySeconds: 60,
      backoffBaseSeconds: 5,
      backoffMaxSeconds: 60,
      maxAttempts: 3,
      saveRetryDelaysMs: [100, 500],
    });
  });

  it('reads the check interval and rejects an invalid one', () => {
    const env = { CHECK_INTERVAL_SECONDS: '2' };

    expect(parseSummarizerConfig(env, 3).checkIntervalSeconds).toBe(2);
    expect(() =>
      parseSummarizerConfig({ CHECK_INTERVAL_SECONDS: 'soon' }, 3),
    ).toThrow('CHECK_INTERVAL_SECONDS');
  });

  it('keeps the claim retry time longer than the call timeout', () => {
    const llm = parseLlmConfig({ DEEPSEEK_API_KEY: 'd' });

    expect(parseSummarizerConfig({}, 3).claimRetrySeconds * 1000).toBeGreaterThan(
      llm.timeoutMs,
    );
  });
});
