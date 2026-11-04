import {
  Catch,
  Logger,
  ServiceUnavailableException,
  type ArgumentsHost,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { isDatabaseUnavailable } from './database-unavailable';

/** Answers 503 when Postgres can't be reached, so a client can tell it may retry. */
@Catch()
export class DatabaseUnavailableFilter extends BaseExceptionFilter {
  private readonly logger = new Logger(DatabaseUnavailableFilter.name);

  override catch(exception: unknown, host: ArgumentsHost): void {
    if (!isDatabaseUnavailable(exception)) {
      super.catch(exception, host);
      return;
    }
    // The client gets a generic message, so the cause has to reach the log.
    this.logger.warn(`Database unavailable: ${String(exception)}`);
    super.catch(
      new ServiceUnavailableException(
        'The database is unavailable. Try again shortly.',
      ),
      host,
    );
  }
}
