import { useEffect, useState, type ReactElement } from 'react';
import { Link, useParams } from 'react-router';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { errorMessage, listSnapshots, type Snapshot } from './api';

const REFETCH_MS = 5000;
// The API returns full history without a limit, which would grow without bound
// on a page that refetches every 5s.
const PAGE_SIZE = 100;

function SummaryLine({
  snapshot,
  isFirst,
}: {
  snapshot: Snapshot;
  isFirst: boolean;
}): ReactElement {
  switch (snapshot.summaryStatus) {
    case 'none':
      return (
        <p className="text-sm text-muted-foreground">
          {isFirst ? 'First snapshot' : 'No change since previous snapshot'}
        </p>
      );
    case 'pending':
      return <Badge variant="secondary">Summary pending…</Badge>;
    case 'failed':
      return <Badge variant="destructive">Summary failed</Badge>;
    case 'done':
      return (
        <div className="rounded-md bg-muted p-3 text-sm">
          <p className="mb-1 text-xs font-medium text-muted-foreground">AI summary</p>
          <p className="break-words">{snapshot.summary}</p>
        </div>
      );
  }
}

function CompetitorTimeline({ id }: { id: string }): ReactElement {
  const [snapshots, setSnapshots] = useState<Snapshot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE_SIZE);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // Schedules the next fetch only after this one ends, so a slow response
    // can't overlap the next request or overwrite a newer one.
    async function load(): Promise<void> {
      try {
        const loaded = await listSnapshots(id, limit);
        if (active) {
          setSnapshots(loaded);
          setError(null);
        }
      } catch (loadError) {
        if (active) {
          setError(errorMessage(loadError));
        }
      }
      if (active) {
        timer = setTimeout(() => {
          void load();
        }, REFETCH_MS);
      }
    }

    void load();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [id, limit]);

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">
          ← Back to competitors
        </Link>
        <h2 className="text-lg font-semibold break-words">{id}</h2>
      </div>

      {error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {snapshots === null && error === null && (
        <p className="text-sm text-muted-foreground">Loading…</p>
      )}
      {snapshots?.length === 0 && <p className="text-sm text-muted-foreground">No snapshots yet.</p>}
      {snapshots !== null && snapshots.length > 0 && (
        <ul className="flex flex-col gap-4">
          {snapshots.map((snapshot, index) => (
            <li key={snapshot.fetchedAt}>
              <Card className="items-start gap-3 p-4">
                <time dateTime={snapshot.fetchedAt} className="text-xs text-muted-foreground">
                  {new Date(snapshot.fetchedAt).toLocaleString()}
                </time>
                <div className="flex w-full flex-col gap-1 break-words">
                  <strong className="font-semibold">{snapshot.title}</strong>
                  <div className="text-sm text-muted-foreground">{snapshot.tagline}</div>
                  <div className="text-sm font-medium">{snapshot.price}</div>
                  <div className="text-sm">{snapshot.description}</div>
                </div>
                <div className="w-full">
                  <SummaryLine
                    snapshot={snapshot}
                    // Below the limit, the oldest row loaded is the oldest there is.
                    isFirst={index === snapshots.length - 1 && snapshots.length < limit}
                  />
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}

      {snapshots !== null && snapshots.length >= limit && (
        <Button
          type="button"
          variant="outline"
          className="self-center"
          onClick={() => {
            setLimit(limit + PAGE_SIZE);
          }}
        >
          Show older
        </Button>
      )}
    </section>
  );
}

export function Timeline(): ReactElement {
  const { id = '' } = useParams();
  // The key starts fresh for another competitor, so its timeline never shows
  // the previous one's snapshots while loading.
  return <CompetitorTimeline key={id} id={id} />;
}
