import Link from 'next/link';

import { NavLink } from '@/components/shell/nav-link';
import { NAV_ITEMS } from '@/components/shell/nav';

export function SiteHeader() {
  return (
    <header className="border-b border-border bg-surface/80 backdrop-blur">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <Link href="/" className="flex items-baseline gap-2">
          <span className="text-lg font-semibold tracking-tight">Tangram</span>
          <span className="hanzi text-sm text-muted">七巧板</span>
        </Link>
        {/* Wraps rather than scrolls: an overflow-x-auto row on a 390px phone
            hides the last link behind an invisible scrollbar. */}
        <nav aria-label="Main" className="-mx-1 flex flex-wrap items-center gap-0.5 sm:gap-1">
          {NAV_ITEMS.map((item) => (
            <NavLink key={item.href} {...item} />
          ))}
        </nav>
      </div>
    </header>
  );
}
