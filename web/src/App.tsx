import type { ReactElement } from 'react';
import { Link, Route, Routes } from 'react-router';
import { CompetitorList } from './CompetitorList';
import { Timeline } from './Timeline';

function NotFound(): ReactElement {
  return (
    <section className="flex flex-col gap-4">
      <p>Page not found.</p>
      <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">
        ← Back to competitors
      </Link>
    </section>
  );
}

export function App(): ReactElement {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-8 px-4 py-8">
      <h1 className="text-xl font-semibold">CompetitorPulse</h1>
      <Routes>
        <Route path="/" element={<CompetitorList />} />
        <Route path="/competitors/:id" element={<Timeline />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </main>
  );
}
