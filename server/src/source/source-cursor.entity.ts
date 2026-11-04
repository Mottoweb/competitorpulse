import { Column, Entity, JoinColumn, OneToOne, PrimaryColumn } from 'typeorm';
import { Competitor } from '../competitors/competitor.entity';

@Entity({ name: 'source_cursors' })
export class SourceCursor {
  @PrimaryColumn({ name: 'competitor_id', type: 'text' })
  competitorId!: string;

  // Declared only for the foreign key. Queries never load it.
  @OneToOne(() => Competitor, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'competitor_id' })
  competitor?: Competitor;

  @Column({ type: 'integer', default: 0 })
  position!: number;
}
