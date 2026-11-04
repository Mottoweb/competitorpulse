import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from './App';
import { snapshot, stubFetch } from './testing/fake-api';

function renderAt(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe('App', () => {
  it('goes from the list to a timeline and back', async () => {
    stubFetch({
      'GET /api/competitors': { status: 200, body: [{ id: 'acme-crm' }] },
      'GET /api/competitors/acme-crm/snapshots?limit=100': {
        status: 200,
        body: [snapshot({ title: 'Acme title' })],
      },
    });
    renderAt('/');

    await userEvent.click(await screen.findByRole('link', { name: 'acme-crm' }));
    expect(await screen.findByText('Acme title')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('link', { name: '← Back to competitors' }));
    expect(await screen.findByLabelText('Competitor id')).toBeInTheDocument();
  });

  it('opens a timeline directly from its URL', async () => {
    stubFetch({
      'GET /api/competitors/ferry-pay/snapshots?limit=100': { status: 200, body: [] },
    });

    renderAt('/competitors/ferry-pay');

    expect(await screen.findByRole('heading', { name: 'ferry-pay' })).toBeInTheDocument();
  });

  it('shows a way back from an unknown page', async () => {
    stubFetch({});

    renderAt('/nope');

    expect(await screen.findByText('Page not found.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '← Back to competitors' })).toHaveAttribute(
      'href',
      '/',
    );
  });
});
