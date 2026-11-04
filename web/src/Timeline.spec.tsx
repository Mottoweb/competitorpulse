import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import type { Snapshot } from './api';
import { snapshot, stubFetch } from './testing/fake-api';
import { Timeline } from './Timeline';

const URL_100 = '/api/competitors/acme-crm/snapshots?limit=100';

function renderTimeline(id = 'acme-crm'): { unmount: () => void } {
  return render(
    <MemoryRouter initialEntries={[`/competitors/${encodeURIComponent(id)}`]}>
      <Routes>
        <Route path="/competitors/:id" element={<Timeline />} />
      </Routes>
    </MemoryRouter>,
  );
}

function ok(body: Snapshot[]): { status: number; body: Snapshot[] } {
  return { status: 200, body };
}

async function advanceSeconds(seconds: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(seconds * 1000);
  });
}

describe('Timeline', () => {
  it('asks for a limited history of the competitor in the URL', async () => {
    const calls = stubFetch({ [`GET ${URL_100}`]: ok([]) });

    renderTimeline();

    expect(await screen.findByRole('heading', { name: 'acme-crm' })).toBeInTheDocument();
    await screen.findByText('No snapshots yet.');
    expect(calls.map((call) => call.url)).toEqual([URL_100]);
  });

  it('shows the fetched time and every listing field', async () => {
    stubFetch({
      [`GET ${URL_100}`]: ok([
        snapshot({
          fetchedAt: '2026-09-10T12:00:00.000Z',
          title: 'Listing title',
          tagline: 'Listing tagline',
          price: '$49/mo',
          description: 'Listing description',
        }),
      ]),
    });

    renderTimeline();

    const item = await screen.findByRole('listitem');
    expect(within(item).getByText('Listing title')).toBeInTheDocument();
    expect(within(item).getByText(/Listing tagline/)).toBeInTheDocument();
    expect(within(item).getByText('$49/mo')).toBeInTheDocument();
    expect(within(item).getByText('Listing description')).toBeInTheDocument();
    const time = item.querySelector('time');
    expect(time).toHaveAttribute('datetime', '2026-09-10T12:00:00.000Z');
    expect(time).toHaveTextContent(new Date('2026-09-10T12:00:00.000Z').toLocaleString());
  });

  it('shows each of the four summary states, newest first', async () => {
    stubFetch({
      [`GET ${URL_100}`]: ok([
        snapshot({
          fetchedAt: '2026-09-10T12:45:00.000Z',
          changed: true,
          summary: 'Price dropped from $39/mo to $29/mo.',
          summaryStatus: 'done',
        }),
        snapshot({
          fetchedAt: '2026-09-10T12:30:00.000Z',
          changed: true,
          summaryStatus: 'pending',
        }),
        snapshot({
          fetchedAt: '2026-09-10T12:15:00.000Z',
          changed: true,
          summaryStatus: 'failed',
        }),
        snapshot({ fetchedAt: '2026-09-10T12:00:00.000Z' }),
        snapshot({ fetchedAt: '2026-09-10T11:45:00.000Z' }),
      ]),
    });

    renderTimeline();

    const items = await screen.findAllByRole('listitem');
    expect(items.map((item) => item.querySelector('time')?.getAttribute('datetime'))).toEqual([
      '2026-09-10T12:45:00.000Z',
      '2026-09-10T12:30:00.000Z',
      '2026-09-10T12:15:00.000Z',
      '2026-09-10T12:00:00.000Z',
      '2026-09-10T11:45:00.000Z',
    ]);
    const [done, pending, failed, none] = items;
    expect(done).toHaveTextContent('Price dropped from $39/mo to $29/mo.');
    expect(pending).toHaveTextContent('Summary pending…');
    expect(failed).toHaveTextContent('Summary failed');
    expect(none).toHaveTextContent('No change since previous snapshot');
  });

  it('labels the first snapshot, because it has nothing to compare with', async () => {
    stubFetch({ [`GET ${URL_100}`]: ok([snapshot()]) });

    renderTimeline();

    const [first] = await screen.findAllByRole('listitem');
    expect(first).toHaveTextContent('First snapshot');
    expect(first).not.toHaveTextContent('No change since previous snapshot');
  });

  it('does not call the oldest loaded snapshot the first when older ones may exist', async () => {
    const full = Array.from({ length: 100 }, (_, index) =>
      snapshot({ fetchedAt: new Date(Date.UTC(2026, 8, 10, 12, index)).toISOString() }),
    );
    stubFetch({ [`GET ${URL_100}`]: ok(full) });

    renderTimeline();

    const items = await screen.findAllByRole('listitem');
    expect(items.at(-1)).toHaveTextContent('No change since previous snapshot');
  });

  it('renders a summary as plain text, because listing text is untrusted', async () => {
    stubFetch({
      [`GET ${URL_100}`]: ok([
        snapshot({
          changed: true,
          summary: '<img src=x alt="injected"> changed',
          summaryStatus: 'done',
        }),
      ]),
    });

    renderTimeline();

    expect(
      await screen.findByText('<img src=x alt="injected"> changed'),
    ).toBeInTheDocument();
    expect(screen.queryByAltText('injected')).not.toBeInTheDocument();
  });

  it('refetches every 5 seconds, so a pending summary fills in', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let summaryReady = false;
    const calls = stubFetch({
      [`GET ${URL_100}`]: () =>
        ok([
          summaryReady
            ? snapshot({ changed: true, summary: 'Now done.', summaryStatus: 'done' })
            : snapshot({ changed: true, summaryStatus: 'pending' }),
        ]),
    });
    renderTimeline();
    await screen.findByText('Summary pending…');
    expect(calls).toHaveLength(1);

    summaryReady = true;
    await advanceSeconds(5);

    expect(await screen.findByText('Now done.')).toBeInTheDocument();
    expect(calls).toHaveLength(2);
  });

  it('stops refetching when the view closes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = stubFetch({ [`GET ${URL_100}`]: ok([snapshot()]) });
    const { unmount } = renderTimeline();
    await screen.findByRole('listitem');
    const before = calls.length;

    unmount();
    await advanceSeconds(20);

    expect(calls).toHaveLength(before);
  });

  it('never runs two refetches at once', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let requests = 0;
    const calls = stubFetch({
      [`GET ${URL_100}`]: () => {
        requests += 1;
        return requests === 1 ? ok([snapshot()]) : new Promise(() => undefined);
      },
    });
    renderTimeline();
    await screen.findByRole('listitem');

    await advanceSeconds(5);
    expect(calls).toHaveLength(2);
    await advanceSeconds(20);

    expect(calls).toHaveLength(2);
  });

  it('keeps the snapshots when a refetch fails, and recovers on the next one', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let failing = false;
    stubFetch({
      [`GET ${URL_100}`]: () =>
        failing
          ? { status: 500, body: { message: 'Internal server error' } }
          : ok([snapshot({ title: 'Still here' })]),
    });
    renderTimeline();
    await screen.findByText('Still here');

    failing = true;
    await advanceSeconds(5);
    expect(await screen.findByRole('alert')).toHaveTextContent('Internal server error');
    expect(screen.getByText('Still here')).toBeInTheDocument();

    failing = false;
    await advanceSeconds(5);
    await screen.findByText('Still here');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the API message for an untracked competitor', async () => {
    stubFetch({
      [`GET ${URL_100}`]: {
        status: 404,
        body: { message: 'Competitor acme-crm is not tracked' },
      },
    });

    renderTimeline();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Competitor acme-crm is not tracked',
    );
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
  });

  it('encodes the id from the URL before calling the API', async () => {
    const calls = stubFetch({});

    renderTimeline('a/b');

    await screen.findByRole('alert');
    expect(calls[0]?.url).toBe('/api/competitors/a%2Fb/snapshots?limit=100');
  });

  it('offers older snapshots only when the limit was reached', async () => {
    const full = Array.from({ length: 100 }, (_, index) =>
      snapshot({ fetchedAt: new Date(Date.UTC(2026, 8, 10, 0, index)).toISOString() }),
    );
    const calls = stubFetch({
      [`GET ${URL_100}`]: ok(full),
      'GET /api/competitors/acme-crm/snapshots?limit=200': ok([
        ...full,
        snapshot({ fetchedAt: '2026-09-09T00:00:00.000Z', title: 'Older one' }),
      ]),
    });
    renderTimeline();

    await userEvent.click(await screen.findByRole('button', { name: 'Show older' }));

    expect(await screen.findByText('Older one')).toBeInTheDocument();
    expect(calls.at(-1)?.url).toContain('limit=200');
    expect(screen.queryByRole('button', { name: 'Show older' })).not.toBeInTheDocument();
  });

  it('hides the older button below the limit', async () => {
    stubFetch({ [`GET ${URL_100}`]: ok([snapshot()]) });

    renderTimeline();

    await screen.findByRole('listitem');
    expect(screen.queryByRole('button', { name: 'Show older' })).not.toBeInTheDocument();
  });
});
