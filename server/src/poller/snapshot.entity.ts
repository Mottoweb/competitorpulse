import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Competitor } from '../competitors/competitor.entity';
import { SUMMARY_STATUSES, type SummaryStatus } from '../competitors/contract';

@Entity({ name: 'snapshots' })
@Index('snapshots_competitor_id_id_idx', ['competitorId', 'id'])
@Index('snapshots_summary_due_idx', ['summaryNextAttemptAt'], {
  where: `summary_status = 'pending'`,
})
export class Snapshot {
  // The pg driver returns bigint as a string, because it can exceed 2^53.
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id!: string;

  @Column({ name: 'competitor_id', type: 'text' })
  competitorId!: string;

  // Declared only for the foreign key. Queries never load it.
  @ManyToOne(() => Competitor, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'competitor_id' })
  competitor?: Competitor;

  @Column({ name: 'fetched_at', type: 'timestamptz' })
  fetchedAt!: Date;

  @Column({ type: 'text' })
  title!: string;

  @Column({ type: 'text' })
  tagline!: string;

  @Column({ type: 'text' })
  price!: string;

  @Column({ type: 'text' })
  description!: string;

  @Column({ name: 'content_hash', type: 'text' })
  contentHash!: string;

  @Column({ type: 'boolean' })
  changed!: boolean;

  @Column({ type: 'text', nullable: true })
  summary!: string | null;

  @Column({
    name: 'summary_status',
    type: 'enum',
    enum: SUMMARY_STATUSES,
    enumName: 'summary_status',
    default: 'none',
  })
  summaryStatus!: SummaryStatus;

  @Column({ name: 'summary_attempts', type: 'integer', default: 0 })
  summaryAttempts!: number;

  @Column({
    name: 'summary_next_attempt_at',
    type: 'timestamptz',
    nullable: true,
  })
  summaryNextAttemptAt!: Date | null;

  @Column({ name: 'summary_error', type: 'text', nullable: true })
  summaryError!: string | null;

  @Column({ name: 'summary_provider', type: 'text', nullable: true })
  summaryProvider!: string | null;

  @Column({ name: 'summary_model', type: 'text', nullable: true })
  summaryModel!: string | null;
}
