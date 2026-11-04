import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { z } from 'zod';
import { SnapshotQueries } from '../poller/snapshot-queries';
import type { Snapshot } from '../poller/snapshot.entity';
import { LISTING_SOURCE, type ListingSource } from '../source/listing-source';
import { Competitor } from './competitor.entity';
import {
  COMPETITOR_ID_MAX_LENGTH,
  COMPETITOR_ID_PATTERN,
  type Competitor as CompetitorContract,
  type Snapshot as SnapshotContract,
} from './contract';

const ID_RULE =
  'id must be 1 to 100 lowercase letters, digits and single hyphens, like acme-crm';

const competitorIdSchema = z
  .string({ error: ID_RULE })
  .max(COMPETITOR_ID_MAX_LENGTH, ID_RULE)
  .regex(COMPETITOR_ID_PATTERN, ID_RULE);

export const addCompetitorSchema = z.object(
  { id: competitorIdSchema },
  { error: ID_RULE },
);

export const snapshotLimitSchema = z.coerce
  .number({ error: 'limit must be a positive integer' })
  .int('limit must be a positive integer')
  .min(1, 'limit must be a positive integer')
  .optional();

const insertedRowsSchema = z.array(z.object({ id: z.string() }));

function toSnapshotContract(row: Snapshot): SnapshotContract {
  return {
    fetchedAt: row.fetchedAt.toISOString(),
    title: row.title,
    tagline: row.tagline,
    price: row.price,
    description: row.description,
    changed: row.changed,
    summary: row.summary,
    summaryStatus: row.summaryStatus,
    summaryProvider: row.summaryProvider,
    summaryModel: row.summaryModel,
  };
}

@Injectable()
export class CompetitorsService {
  private readonly logger = new Logger(CompetitorsService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly snapshots: SnapshotQueries,
    @Inject(LISTING_SOURCE) private readonly source: ListingSource,
  ) {}

  async list(): Promise<CompetitorContract[]> {
    const rows = await this.dataSource.manager.find(Competitor, {
      select: { id: true },
      order: { id: 'ASC' },
    });
    return rows.map((row) => ({ id: row.id }));
  }

  /**
   * The insert alone decides between 201 and 409, so concurrent adds can't both
   * succeed or fail on a constraint error. The column default makes it due now.
   */
  async add(id: string): Promise<CompetitorContract> {
    if (!(await this.source.isKnown(id))) {
      throw new UnprocessableEntityException(`Unknown competitor: ${id}`);
    }

    const result = await this.dataSource
      .createQueryBuilder()
      .insert()
      .into(Competitor)
      .values({ id })
      .orIgnore()
      .returning('id')
      .updateEntity(false)
      .execute();
    if (insertedRowsSchema.parse(result.raw).length === 0) {
      throw new ConflictException(`Already tracked: ${id}`);
    }
    this.logger.log(`Now tracking ${id}`);
    return { id };
  }

  /** The foreign keys cascade, so this also removes snapshots and the cursor. */
  async remove(id: string): Promise<void> {
    this.assertCouldBeTracked(id);
    const result = await this.dataSource.manager.delete(Competitor, { id });
    if (result.affected === 0) {
      throw this.notTracked(id);
    }
    this.logger.log(`Stopped tracking ${id}`);
  }

  async listSnapshots(
    id: string,
    limit: number | undefined,
  ): Promise<SnapshotContract[]> {
    this.assertCouldBeTracked(id);
    const tracked = await this.dataSource.manager.existsBy(Competitor, { id });
    if (!tracked) {
      throw this.notTracked(id);
    }
    const rows = await this.snapshots.listTimeline(id, limit);
    return rows.map(toSnapshotContract);
  }

  /**
   * An id that fails the format was never added. Stopping here also keeps bytes
   * Postgres rejects, such as NUL, from turning a 404 into a 500.
   */
  private assertCouldBeTracked(id: string): void {
    if (!competitorIdSchema.safeParse(id).success) {
      throw this.notTracked(id);
    }
  }

  private notTracked(id: string): NotFoundException {
    return new NotFoundException(`Not tracked: ${id}`);
  }
}
