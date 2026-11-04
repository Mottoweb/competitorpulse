import { describe, expect, it, vi } from 'vitest';
import { errorMessage, listCompetitors, REQUEST_TIMEOUT_MS } from './api';

/** A server that never answers, and fails only when the request is cancelled. */
function neverAnswers(_request: Request, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });
}

describe('API requests', () => {
  it('give up on a server that never answers', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', neverAnswers);
    let outcome = 'still waiting';

    void listCompetitors().catch((error: unknown) => {
      outcome = errorMessage(error);
    });
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);

    expect(outcome).toBe('Could not reach the server');
  });
});
