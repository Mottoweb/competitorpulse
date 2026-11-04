import { QueryFailedError } from 'typeorm';

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

// SQLSTATE: connection failures, the server shutting down or starting up, and
// too many connections. https://www.postgresql.org/docs/16/errcodes-appendix.html
const POSTGRES_CODES = new Set(['57P01', '57P02', '57P03', '53300']);
const POSTGRES_CONNECTION_CLASS = '08';

// node-postgres raises these from the pool with no code.
const POOL_MESSAGES = [
  'Connection terminated',
  'timeout exceeded when trying to connect',
  'Query read timeout',
  'Client has encountered a connection error',
];

function codeOf(error: Error): string | undefined {
  return 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

/** Whether an error means Postgres couldn't be reached, rather than a bug. */
export function isDatabaseUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const cause: unknown = error instanceof QueryFailedError ? error.driverError : error;
  if (!(cause instanceof Error)) {
    return false;
  }
  const code = codeOf(cause);
  if (code !== undefined) {
    return (
      NETWORK_CODES.has(code) ||
      POSTGRES_CODES.has(code) ||
      code.startsWith(POSTGRES_CONNECTION_CLASS)
    );
  }
  return POOL_MESSAGES.some((message) => cause.message.includes(message));
}
