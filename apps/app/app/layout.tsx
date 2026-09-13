import type { Metadata, Viewport } from 'next';

import { RegisterServiceWorker } from '@/components/pwa/register-sw';
import { DataBanner } from '@/components/shell/data-banner';
import { SiteHeader } from '@/components/shell/site-header';
import { TestHooks } from '@/components/shell/test-hooks';
import './globals.css';

export const metadata: Metadata = {
  title: 'Tangram',
  description: 'Look it up in context, keep it, review it.',
  // Emits <link rel="manifest" href="/manifest.webmanifest"> (PLAN.md §3.6).
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, title: 'Tangram', statusBarStyle: 'default' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0f766e',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh">
        <SiteHeader />
        <DataBanner />
        <TestHooks />
        <RegisterServiceWorker />
        <main className="mx-auto w-full max-w-3xl px-4 py-6 sm:py-8">{children}</main>
      </body>
    </html>
  );
}
