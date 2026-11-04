import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { EmptyResponseError, backoffSeconds, classifyFailure } from './failure';

const openAiError = (status: number): Error =>
  new OpenAI.APIError(status, undefined, 'failed', new Headers());

describe('classifyFailure', () => {
  it('follows the failover table for each HTTP status', () => {
    const table = {
      408: 'transient',
      429: 'transient',
      500: 'transient',
      503: 'transient',
      529: 'transient',
      401: 'provider_unusable',
      402: 'provider_unusable',
      403: 'provider_unusable',
      404: 'provider_unusable',
      400: 'bad_request',
      413: 'bad_request',
      422: 'bad_request',
    };

    const classified = Object.fromEntries(
      Object.keys(table).map((status) => [
        status,
        classifyFailure(openAiError(Number(status))),
      ]),
    );

    expect(classified).toEqual(table);
  });

  it('reads the status from Anthropic errors too', () => {
    const error = (status: number): Error =>
      new Anthropic.APIError(status, undefined, 'failed', new Headers());

    expect([429, 401, 400].map((status) => classifyFailure(error(status)))).toEqual(
      ['transient', 'provider_unusable', 'bad_request'],
    );
  });

  it('treats timeouts, network errors and empty responses as transient', () => {
    const failures = [
      new OpenAI.APIConnectionTimeoutError(),
      new OpenAI.APIConnectionError({ message: 'refused' }),
      new OpenAI.APIUserAbortError(),
      new EmptyResponseError('deepseek'),
      new TypeError('fetch failed'),
    ];

    expect(new Set(failures.map(classifyFailure))).toEqual(
      new Set(['transient']),
    );
  });
});

describe('backoffSeconds', () => {
  it('doubles with each attempt, up to the maximum', () => {
    expect([1, 2, 3, 4, 5].map((n) => backoffSeconds(n, 5, 30))).toEqual([
      5, 10, 20, 30, 30,
    ]);
  });
});
