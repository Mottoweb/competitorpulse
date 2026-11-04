import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

export type FailureKind = 'transient' | 'provider_unusable' | 'bad_request';

export class EmptyResponseError extends Error {
  constructor(provider: string) {
    super(`${provider} returned an empty response`);
  }
}

function statusOf(error: unknown): number | undefined {
  if (
    !(error instanceof OpenAI.APIError || error instanceof Anthropic.APIError)
  ) {
    return undefined;
  }
  const status: unknown = error.status;
  return typeof status === 'number' ? status : undefined;
}

/** Anything without an HTTP status is a timeout, a network error or an empty reply. */
export function classifyFailure(error: unknown): FailureKind {
  const status = statusOf(error);
  if (status === undefined || status === 408 || status === 429 || status >= 500) {
    return 'transient';
  }
  if (status === 401 || status === 402 || status === 403 || status === 404) {
    return 'provider_unusable';
  }
  return 'bad_request';
}

export function backoffSeconds(
  attempt: number,
  baseSeconds: number,
  maxSeconds: number,
): number {
  return Math.min(baseSeconds * 2 ** (attempt - 1), maxSeconds);
}
