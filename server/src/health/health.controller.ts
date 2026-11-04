import {
  Controller,
  Get,
  Inject,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiProperty,
  ApiSchema,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { DataSource } from 'typeorm';

export const HEALTH_QUERY_TIMEOUT_MS = Symbol('HEALTH_QUERY_TIMEOUT_MS');

// Shorter than the 3s the compose healthcheck allows, so it sees this answer.
const DEFAULT_QUERY_TIMEOUT_MS = 2_000;

@ApiSchema({ name: 'Health' })
class HealthDto {
  @ApiProperty({ enum: ['ok'] })
  status!: 'ok';
}

@ApiSchema({ name: 'HealthUnavailable' })
class HealthUnavailableDto {
  @ApiProperty({ enum: ['unavailable'] })
  status!: 'unavailable';
}

@ApiTags('health')
@Controller('healthz')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly dataSource: DataSource,
    @Optional()
    @Inject(HEALTH_QUERY_TIMEOUT_MS)
    private readonly queryTimeoutMs: number = DEFAULT_QUERY_TIMEOUT_MS,
  ) {}

  @Get()
  @ApiOkResponse({ type: HealthDto })
  @ApiServiceUnavailableResponse({ type: HealthUnavailableDto })
  async check(): Promise<HealthDto> {
    try {
      await this.queryWithTimeout();
    } catch (error) {
      this.logger.warn(`Postgres is unreachable: ${String(error)}`);
      throw new ServiceUnavailableException({ status: 'unavailable' });
    }
    return { status: 'ok' };
  }

  /** A host that never answers produces no error, so the query needs its own limit. */
  private async queryWithTimeout(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`no answer within ${this.queryTimeoutMs}ms`));
      }, this.queryTimeoutMs);
    });
    try {
      await Promise.race([this.dataSource.query('SELECT 1'), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}
