import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

@Entity({ name: 'competitors' })
export class Competitor {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  // Defaults to now() so a newly added competitor is due immediately.
  @Index('competitors_next_poll_at_idx')
  @Column({ name: 'next_poll_at', type: 'timestamptz', default: () => 'now()' })
  nextPollAt!: Date;
}
