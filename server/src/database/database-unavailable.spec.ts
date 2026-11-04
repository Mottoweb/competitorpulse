import { QueryFailedError } from 'typeorm';
import { isDatabaseUnavailable } from './database-unavailable';

function withCode(code: string): Error {
  return Object.assign(new Error('driver error'), { code });
}

describe('isDatabaseUnavailable', () => {
  it.each(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH'])(
    'is true for the network error %s',
    (code) => {
      expect(isDatabaseUnavailable(withCode(code))).toBe(true);
    },
  );

  it.each(['57P01', '57P02', '57P03', '08006', '08001', '53300'])(
    'is true for the Postgres error %s',
    (code) => {
      expect(isDatabaseUnavailable(withCode(code))).toBe(true);
    },
  );

  it.each([
    'Connection terminated unexpectedly',
    'Connection terminated due to connection timeout',
    'timeout exceeded when trying to connect',
    'Query read timeout',
    'Client has encountered a connection error and is not queryable',
  ])('is true for the pool error "%s"', (message) => {
    expect(isDatabaseUnavailable(new Error(message))).toBe(true);
  });

  it('looks inside the error TypeORM wraps around a failed query', () => {
    const wrapped = new QueryFailedError('SELECT 1', [], withCode('57P01'));

    expect(isDatabaseUnavailable(wrapped)).toBe(true);
  });

  it.each([
    ['a constraint violation', new QueryFailedError('INSERT', [], withCode('23505'))],
    ['a plain bug', new Error('a bug')],
    ['something that is not an error', 'ECONNREFUSED'],
    ['nothing', undefined],
  ])('is false for %s', (_name, error) => {
    expect(isDatabaseUnavailable(error)).toBe(false);
  });
});
