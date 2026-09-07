'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { cn } from '@/lib/cn';

export function NavLink({ href, label }: { href: string; label: string }) {
  const pathname = usePathname();
  const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        // Tight enough that six links fit one phone row; py-2 gives the link a
        // hand-sized target rather than the 28px a py-1 row would have.
        'rounded-md px-1.5 py-2 text-sm whitespace-nowrap transition sm:px-2',
        active ? 'bg-accent-soft text-accent font-medium' : 'text-muted hover:text-foreground',
      )}
    >
      {label}
    </Link>
  );
}
