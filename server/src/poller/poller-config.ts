import { z } from 'zod';

export interface PollerConfig {
  pollIntervalSeconds: number;
  checkIntervalSeconds: number;
  /** 0.1 spreads the next poll over the interval plus or minus 10%. */
  jitterRatio: number;
  /** The most polls running at once. */
  concurrency: number;
  /** The wait before each retry of a failed snapshot write. */
  saveRetryDelaysMs: number[];
}

export const POLLER_CONFIG = Symbol('POLLER_CONFIG');

const pollerEnvSchema = z.object({
  POLL_INTERVAL_SECONDS: z.coerce.number().positive().default(900),
  CHECK_INTERVAL_SECONDS: z.coerce.number().positive().default(15),
});

export function parsePollerConfig(env: NodeJS.ProcessEnv): PollerConfig {
  const result = pollerEnvSchema.safeParse(env);
  if (!result.success) {
    const invalid = result.error.issues.map((issue) => issue.path.join('.'));
    throw new Error(`Invalid poller configuration: ${invalid.join(', ')}`);
  }
  return {
    pollIntervalSeconds: result.data.POLL_INTERVAL_SECONDS,
    checkIntervalSeconds: result.data.CHECK_INTERVAL_SECONDS,
    jitterRatio: 0.1,
    concurrency: 10,
    saveRetryDelaysMs: [100, 500],
  };
}
