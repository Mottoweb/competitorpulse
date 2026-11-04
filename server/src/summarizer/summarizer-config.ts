import { z } from 'zod';

export interface SummarizerConfig {
  checkIntervalSeconds: number;
  /** The most LLM calls running at once. */
  concurrency: number;
  /** Must stay longer than the LLM timeout, or a slow call gets claimed twice. */
  claimRetrySeconds: number;
  backoffBaseSeconds: number;
  backoffMaxSeconds: number;
  maxAttempts: number;
  /** The wait before each retry of saving a summary that is already paid for. */
  saveRetryDelaysMs: number[];
}

export const SUMMARIZER_CONFIG = Symbol('SUMMARIZER_CONFIG');

const summarizerEnvSchema = z.object({
  CHECK_INTERVAL_SECONDS: z.coerce.number().positive().default(15),
});

export function parseSummarizerConfig(
  env: NodeJS.ProcessEnv,
  maxAttempts: number,
): SummarizerConfig {
  const result = summarizerEnvSchema.safeParse(env);
  if (!result.success) {
    const invalid = result.error.issues.map((issue) => issue.path.join('.'));
    throw new Error(`Invalid summarizer configuration: ${invalid.join(', ')}`);
  }
  return {
    checkIntervalSeconds: result.data.CHECK_INTERVAL_SECONDS,
    concurrency: 5,
    claimRetrySeconds: 60,
    backoffBaseSeconds: 5,
    backoffMaxSeconds: 60,
    maxAttempts,
    saveRetryDelaysMs: [100, 500],
  };
}
