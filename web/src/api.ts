import createClient from 'openapi-fetch';
import type { components, paths } from './generated/api';

export type Competitor = components['schemas']['Competitor'];
export type Snapshot = components['schemas']['Snapshot'];

export const REQUEST_TIMEOUT_MS = 15_000;

/** The timer stays running after the headers arrive, so it also covers reading the body. */
function fetchWithTimeout(request: Request): Promise<Response> {
  const controller = new AbortController();
  setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  // Looks fetch up on each call, rather than keeping the one present at import.
  return globalThis.fetch(request, { signal: controller.signal });
}

const client = createClient<paths>({
  baseUrl: window.location.origin,
  fetch: fetchWithTimeout,
});

/** A failed API call. Its message is written to be shown to the user. */
export class ApiError extends Error {}

export function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Something went wrong';
}

/** An error may come from a proxy rather than the API, so its body isn't trusted. */
function apiMessage(body: unknown): string | undefined {
  return typeof body === 'object' &&
    body !== null &&
    'message' in body &&
    typeof body.message === 'string'
    ? body.message
    : undefined;
}

async function send<T>(
  request: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T | undefined> {
  let result: Awaited<typeof request>;
  try {
    result = await request;
  } catch {
    throw new ApiError('Could not reach the server');
  }
  if (!result.response.ok) {
    throw new ApiError(
      apiMessage(result.error) ?? `Request failed (${result.response.status})`,
    );
  }
  return result.data;
}

async function sendForData<T>(
  request: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  const data = await send(request);
  if (data === undefined) {
    throw new ApiError('Unexpected response from the server');
  }
  return data;
}

export function listCompetitors(): Promise<Competitor[]> {
  return sendForData(client.GET('/api/competitors'));
}

export async function addCompetitor(id: string): Promise<void> {
  await send(client.POST('/api/competitors', { body: { id } }));
}

export async function removeCompetitor(id: string): Promise<void> {
  await send(
    client.DELETE('/api/competitors/{id}', { params: { path: { id } } }),
  );
}

export function listSnapshots(id: string, limit: number): Promise<Snapshot[]> {
  return sendForData(
    client.GET('/api/competitors/{id}/snapshots', {
      params: { path: { id }, query: { limit } },
    }),
  );
}
