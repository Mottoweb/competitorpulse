import {
  Inject,
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  LISTING_SOURCE,
  type FetchedListing,
  type ListingSource,
} from '../source/listing-source';
import { POLLER_CONFIG, type PollerConfig } from './poller-config';
import {
  SnapshotQueries,
  type ClaimedCompetitor,
  type SavedSnapshot,
} from './snapshot-queries';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeSave(saved: SavedSnapshot): string {
  if (saved.first) {
    return 'first snapshot saved';
  }
  return saved.changed ? 'changed, summary queued' : 'no change';
}

@Injectable()
export class PollWorker
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(PollWorker.name);
  private current: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(
    private readonly queries: SnapshotQueries,
    @Inject(LISTING_SOURCE) private readonly source: ListingSource,
    @Inject(POLLER_CONFIG) private readonly config: PollerConfig,
  ) {}

  onApplicationBootstrap(): void {
    this.logger.log(
      `Polling every ${this.config.pollIntervalSeconds}s, checking every ${this.config.checkIntervalSeconds}s`,
    );
    void this.check();
    this.timer = setInterval(
      () => void this.check(),
      this.config.checkIntervalSeconds * 1000,
    );
  }

  /** Runs before the database closes, so a check in progress can finish its saves. */
  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
    }
    await this.current;
  }

  /** Never rejects. A check already running on this instance is joined, not repeated. */
  check(): Promise<void> {
    this.current ??= this.drain().finally(() => {
      this.current = null;
    });
    return this.current;
  }

  private async drain(): Promise<void> {
    try {
      // Sequential on purpose: each batch waits for the last, which caps concurrency.
      while (!this.stopping) {
        const claimed = await this.queries.claimDueCompetitors({
          limit: this.config.concurrency,
          intervalSeconds: this.config.pollIntervalSeconds,
          jitterRatio: this.config.jitterRatio,
        });
        if (claimed.length === 0) {
          return;
        }
        await Promise.all(claimed.map((competitor) => this.poll(competitor)));
      }
    } catch (error) {
      this.logger.error(`Poll check failed: ${messageOf(error)}`);
    }
  }

  /** A failure writes nothing. The competitor is polled again when next due. */
  private async poll(competitor: ClaimedCompetitor): Promise<void> {
    try {
      const fetched = await this.source.fetchListing(competitor.id);
      await this.saveWithRetry(competitor, fetched, new Date());
    } catch (error) {
      this.logger.error(`Poll of ${competitor.id} failed: ${messageOf(error)}`);
    }
  }

  /** Reuses the listing already fetched, so a retry doesn't fetch it again. */
  private async saveWithRetry(
    competitor: ClaimedCompetitor,
    fetched: FetchedListing,
    fetchedAt: Date,
  ): Promise<void> {
    const competitorId = competitor.id;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const saved = await this.queries.saveSnapshot({
          competitorId,
          listing: fetched.listing,
          fetchedAt,
          claimedCreatedAt: competitor.createdAt,
          inTransaction: (tx) => fetched.markSaved(tx),
        });
        if (saved === null) {
          this.logger.log(`${competitorId} was deleted or re-added during its poll`);
          return;
        }
        this.logger.log(`${competitorId}: ${describeSave(saved)}`);
        return;
      } catch (error) {
        const delayMs = this.config.saveRetryDelaysMs[attempt];
        if (delayMs === undefined) {
          throw error;
        }
        this.logger.warn(
          `Save for ${competitorId} failed, retrying: ${messageOf(error)}`,
        );
        await sleep(delayMs);
      }
    }
  }
}
