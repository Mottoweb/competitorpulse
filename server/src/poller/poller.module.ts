import { Module } from '@nestjs/common';
import { SourceModule } from '../source/source.module';
import { PollWorker } from './poll-worker';
import { POLLER_CONFIG, parsePollerConfig } from './poller-config';
import { SnapshotQueries } from './snapshot-queries';

@Module({
  imports: [SourceModule],
  providers: [
    SnapshotQueries,
    PollWorker,
    {
      provide: POLLER_CONFIG,
      useFactory: () => parsePollerConfig(process.env),
    },
  ],
  exports: [SnapshotQueries],
})
export class PollerModule {}
