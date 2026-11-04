import { vi } from 'vitest';
import type { Snapshot } from '../api';

export interface FakeReply {
  status: number;
  body?: unknown;
  /** Sent as text rather than JSON, like an error page from a proxy. */
  text?: string;
}

export interface FakeCall {
  method: string;
  url: string;
  body: unknown;
}

export type FakeRoute = FakeReply | ((call: FakeCall) => FakeReply | Promise<FakeReply>);

function toResponse(reply: FakeReply): Response {
  if (reply.text !== undefined) {
    return new Response(reply.text, { status: reply.status });
  }
  if (reply.body === undefined) {
    return new Response(null, { status: reply.status });
  }
  return new Response(JSON.stringify(reply.body), {
    status: reply.status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Replaces fetch with a table of "METHOD /url" routes and records every call.
 * A request with no route fails its test with a 599, so nothing goes unnoticed.
 */
export function stubFetch(routes: Record<string, FakeRoute>): FakeCall[] {
  const calls: FakeCall[] = [];
  const fakeFetch = async (request: Request): Promise<Response> => {
    const parsed = new URL(request.url);
    const url = parsed.pathname + parsed.search;
    const text = await request.clone().text();
    const call: FakeCall = {
      method: request.method,
      url,
      body: text === '' ? undefined : (JSON.parse(text) as unknown),
    };
    calls.push(call);
    const route = routes[`${request.method} ${url}`];
    if (route === undefined) {
      return toResponse({ status: 599, body: { message: `No route: ${request.method} ${url}` } });
    }
    return toResponse(typeof route === 'function' ? await route(call) : route);
  };
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
  return calls;
}

export function snapshot(fields: Partial<Snapshot> = {}): Snapshot {
  return {
    fetchedAt: '2026-09-10T12:00:00.000Z',
    title: 'Acme CRM',
    tagline: 'Simple CRM for small teams',
    price: '$29/mo',
    description: 'Track leads and deals in one place.',
    changed: false,
    summary: null,
    summaryStatus: 'none',
    summaryProvider: null,
    summaryModel: null,
    ...fields,
  };
}
