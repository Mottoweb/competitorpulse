import { parsePollerConfig } from './poller-config';

describe('parsePollerConfig', () => {
  it('uses the planned defaults', () => {
    expect(parsePollerConfig({})).toEqual({
      pollIntervalSeconds: 900,
      checkIntervalSeconds: 15,
      jitterRatio: 0.1,
      concurrency: 10,
      saveRetryDelaysMs: [100, 500],
    });
  });

  it('reads the intervals from the environment', () => {
    const config = parsePollerConfig({
      POLL_INTERVAL_SECONDS: '20',
      CHECK_INTERVAL_SECONDS: '2',
    });

    expect(config.pollIntervalSeconds).toBe(20);
    expect(config.checkIntervalSeconds).toBe(2);
  });

  it.each([
    ['POLL_INTERVAL_SECONDS', 'soon'],
    ['POLL_INTERVAL_SECONDS', '0'],
    ['CHECK_INTERVAL_SECONDS', '-1'],
  ])('rejects %s=%s and names the setting', (name, value) => {
    expect(() => parsePollerConfig({ [name]: value })).toThrow(name);
  });
});
