import { Link } from 'react-router';

/**
 * The wordmark row (docs/plans/core.md C7).
 *
 * What is left of the seven-route header. The nav that used to sit beside it is
 * the tab bar now — at the bottom on a phone, in the header on a wide screen —
 * so this is the name of the app and the way home, and both shells render the
 * same one so the two cannot drift.
 *
 * The 七巧板 wordmark stays **plain type, no ruby** (C3's call-site table): it
 * is a logotype, not a reading surface, and a reading over it would be the one
 * place in the app where pinyin is decoration.
 */
export function SiteHeader({ className }: { className?: string }) {
  return (
    <Link to="/" data-testid="wordmark" className={className ?? 'flex items-baseline gap-2'}>
      <span className="text-lg font-semibold tracking-tight">Tangram</span>
      <span className="hanzi text-sm text-muted">七巧板</span>
    </Link>
  );
}
