/**
 * The root route element — what `app/layout.tsx` composed (docs/plans/web.md W1).
 *
 * `<html>` and `<body>` live in `index.html` now, with the metadata and viewport
 * that Next's `metadata`/`viewport` exports emitted. What is left is the four
 * mounted-once components and the `<main>` wrapper, plus the `<Outlet />` that
 * used to be `children`.
 */
import { Outlet } from 'react-router';

import { RegisterServiceWorker } from '@/components/pwa/register-sw';
import { DataBanner } from '@/components/shell/data-banner';
import { SiteHeader } from '@/components/shell/site-header';
import { TestHooks } from '@/components/shell/test-hooks';

export function Root() {
  return (
    <>
      <SiteHeader />
      <DataBanner />
      <TestHooks />
      <RegisterServiceWorker />
      <main className="mx-auto w-full max-w-3xl px-4 py-6 sm:py-8">
        <Outlet />
      </main>
    </>
  );
}
