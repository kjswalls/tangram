/** The seven routes. The nav, the smoke spec and the phase notes all read this. */
export interface NavItem {
  href: string;
  label: string;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/', label: 'Today' },
  { href: '/lookup', label: 'Lookup' },
  { href: '/review', label: 'Review' },
  { href: '/read', label: 'Read' },
  { href: '/lists', label: 'Lists' },
  { href: '/stats', label: 'Stats' },
  { href: '/settings', label: 'Settings' },
];
