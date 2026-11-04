import { ApiProperty, ApiSchema } from '@nestjs/swagger';
import {
  COMPETITOR_ID_MAX_LENGTH,
  COMPETITOR_ID_PATTERN,
  SUMMARY_STATUSES,
  type Competitor,
  type Snapshot,
  type SummaryStatus,
} from './contract';

// Swagger reads these decorators, and the compiler can't compare a decorator
// with its field. `implements` at least ties the field names and types to the
// contract the service returns; the spec tests check the decorators.

@ApiSchema({ name: 'AddCompetitor' })
export class AddCompetitorDto implements Competitor {
  @ApiProperty({
    example: 'acme-crm',
    maxLength: COMPETITOR_ID_MAX_LENGTH,
    pattern: COMPETITOR_ID_PATTERN.source,
  })
  id!: string;
}

@ApiSchema({ name: 'Competitor' })
export class CompetitorDto implements Competitor {
  @ApiProperty({ example: 'acme-crm' })
  id!: string;
}

@ApiSchema({ name: 'Snapshot' })
export class SnapshotDto implements Snapshot {
  @ApiProperty({ type: String, format: 'date-time' })
  fetchedAt!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  tagline!: string;

  @ApiProperty()
  price!: string;

  @ApiProperty()
  description!: string;

  @ApiProperty({ description: 'Whether this snapshot differs from the previous one' })
  changed!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Set only when summaryStatus is done',
  })
  summary!: string | null;

  @ApiProperty({ enum: [...SUMMARY_STATUSES], enumName: 'SummaryStatus' })
  summaryStatus!: SummaryStatus;

  @ApiProperty({ type: String, nullable: true })
  summaryProvider!: string | null;

  @ApiProperty({ type: String, nullable: true })
  summaryModel!: string | null;
}
