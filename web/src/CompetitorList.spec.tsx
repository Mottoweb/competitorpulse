import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { CompetitorList } from './CompetitorList';
import { stubFetch, type FakeCall, type FakeReply } from './testing/fake-api';

function renderList(): void {
  render(
    <MemoryRouter>
      <CompetitorList />
    </MemoryRouter>,
  );
}

async function confirmRemove(): Promise<void> {
  const dialog = await screen.findByRole('alertdialog');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
}

/** A small stateful server, so the tests see the list refetched after a change. */
function trackedServer(initial: string[]): {
  list: () => FakeReply;
  add: (call: FakeCall) => FakeReply;
  remove: (id: string) => () => FakeReply;
} {
  const ids = [...initial];
  return {
    list: () => ({ status: 200, body: ids.map((id) => ({ id })) }),
    add: (call: FakeCall) => {
      const { body } = call;
      if (typeof body !== 'object' || body === null || !('id' in body) || typeof body.id !== 'string') {
        throw new Error('Expected a body with a string id');
      }
      const { id } = body;
      ids.push(id);
      return { status: 201, body: { id } };
    },
    remove: (id: string) => () => {
      ids.splice(ids.indexOf(id), 1);
      return { status: 204 };
    },
  };
}

describe('CompetitorList', () => {
  it('asks before removing, naming the competitor, and keeps it if cancelled', async () => {
    const calls = stubFetch({
      'GET /api/competitors': { status: 200, body: [{ id: 'acme-crm' }] },
    });
    renderList();
    await screen.findByRole('link', { name: 'acme-crm' });

    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('acme-crm');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
    expect(screen.getByRole('link', { name: 'acme-crm' })).toBeInTheDocument();
  });

  it('lists tracked competitors, each linking to its timeline', async () => {
    stubFetch({
      'GET /api/competitors': {
        status: 200,
        body: [{ id: 'acme-crm' }, { id: 'ferry-pay' }],
      },
    });

    renderList();

    expect(await screen.findByRole('link', { name: 'acme-crm' })).toHaveAttribute(
      'href',
      '/competitors/acme-crm',
    );
    expect(screen.getByRole('link', { name: 'ferry-pay' })).toHaveAttribute(
      'href',
      '/competitors/ferry-pay',
    );
  });

  it('says so when nothing is tracked', async () => {
    stubFetch({ 'GET /api/competitors': { status: 200, body: [] } });

    renderList();

    expect(await screen.findByText('No competitors tracked yet.')).toBeInTheDocument();
  });

  it('adds a competitor, refreshes the list and clears the form', async () => {
    const server = trackedServer([]);
    const calls = stubFetch({
      'GET /api/competitors': server.list,
      'POST /api/competitors': server.add,
    });
    renderList();
    await screen.findByText('No competitors tracked yet.');

    const input = screen.getByLabelText('Competitor id');
    await userEvent.type(input, '  acme-crm ');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(await screen.findByRole('link', { name: 'acme-crm' })).toBeInTheDocument();
    expect(calls.find((call) => call.method === 'POST')?.body).toEqual({ id: 'acme-crm' });
    expect(input).toHaveValue('');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each([
    [400, 'Competitor id must be lowercase letters, digits and single hyphens'],
    [409, 'Competitor acme-crm is already tracked'],
    [422, 'The source does not know competitor nope'],
  ])('shows the API message for a %i and keeps what was typed', async (status, message) => {
    stubFetch({
      'GET /api/competitors': { status: 200, body: [] },
      'POST /api/competitors': { status, body: { message, statusCode: status } },
    });
    renderList();
    await screen.findByText('No competitors tracked yet.');

    const input = screen.getByLabelText('Competitor id');
    await userEvent.type(input, 'nope');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(input).toHaveValue('nope');
  });

  it('clears an earlier error once an add succeeds', async () => {
    const server = trackedServer([]);
    let rejectNext = true;
    stubFetch({
      'GET /api/competitors': server.list,
      'POST /api/competitors': (call) => {
        if (rejectNext) {
          rejectNext = false;
          return { status: 409, body: { message: 'Already tracked' } };
        }
        return server.add(call);
      },
    });
    renderList();
    await screen.findByText('No competitors tracked yet.');

    await userEvent.type(screen.getByLabelText('Competitor id'), 'acme-crm');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    await screen.findByRole('alert');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));

    await screen.findByRole('link', { name: 'acme-crm' });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('removes a competitor and refreshes the list', async () => {
    const server = trackedServer(['acme-crm', 'ferry-pay']);
    const calls = stubFetch({
      'GET /api/competitors': server.list,
      'DELETE /api/competitors/acme-crm': server.remove('acme-crm'),
    });
    renderList();

    const row = (await screen.findByRole('link', { name: 'acme-crm' })).closest('li');
    if (row === null) {
      throw new Error('Expected the link to sit in a list item');
    }
    await userEvent.click(within(row).getByRole('button', { name: 'Remove' }));
    await confirmRemove();

    await waitFor(() => {
      expect(screen.queryByRole('link', { name: 'acme-crm' })).not.toBeInTheDocument();
    });
    expect(screen.getByRole('link', { name: 'ferry-pay' })).toBeInTheDocument();
    expect(calls.some((call) => call.method === 'DELETE')).toBe(true);
  });

  it('shows the API message when a remove fails, and keeps the row', async () => {
    stubFetch({
      'GET /api/competitors': { status: 200, body: [{ id: 'acme-crm' }] },
      'DELETE /api/competitors/acme-crm': {
        status: 404,
        body: { message: 'Competitor acme-crm is not tracked' },
      },
    });
    renderList();
    await screen.findByRole('link', { name: 'acme-crm' });

    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await confirmRemove();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Competitor acme-crm is not tracked',
    );
    expect(screen.getByRole('link', { name: 'acme-crm' })).toBeInTheDocument();
  });

  it('refreshes the list after a failed remove, so a stale row can clear', async () => {
    let lists = 0;
    stubFetch({
      'GET /api/competitors': () => {
        lists += 1;
        return { status: 200, body: lists === 1 ? [{ id: 'acme-crm' }] : [] };
      },
      'DELETE /api/competitors/acme-crm': {
        status: 404,
        body: { message: 'Competitor acme-crm is not tracked' },
      },
    });
    renderList();
    await screen.findByRole('link', { name: 'acme-crm' });

    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await confirmRemove();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Competitor acme-crm is not tracked',
    );
    await waitFor(() => {
      expect(screen.queryByRole('link', { name: 'acme-crm' })).not.toBeInTheDocument();
    });
  });

  it('shows the API message when the list fails to load', async () => {
    stubFetch({
      'GET /api/competitors': {
        status: 500,
        body: { message: 'Internal server error' },
      },
    });

    renderList();

    expect(await screen.findByRole('alert')).toHaveTextContent('Internal server error');
  });

  it('falls back to the status when an error has no API message', async () => {
    stubFetch({ 'GET /api/competitors': { status: 502, text: '<html>Bad gateway</html>' } });

    renderList();

    expect(await screen.findByRole('alert')).toHaveTextContent('Request failed (502)');
  });

  it('explains a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    renderList();

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the server');
  });
});
