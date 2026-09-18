'use client';

/**
 * The help sheet, generated from the registry (docs/plans/web.md W8).
 *
 * W8's first reason for a table rather than scattered handlers is that "a help
 * sheet can be generated from it", and its first acceptance criterion is that
 * every binding carries a human-readable description *because* the sheet is
 * generated. This is the consumer that makes that true: nothing here names a
 * key or writes a description, so a binding added to `registry.ts` appears here
 * and a binding without a description would appear here blank — which is what
 * `tests/unit/keys/registry.test.ts` refuses.
 *
 * It reuses `components/ui/sheet.tsx` rather than growing a second dialog: the
 * focus move in, the return to wherever focus was when it opened, the Tab trap
 * and Escape are all C1's and are unit-tested there. In particular **Escape
 * always leaves**, which is W8 rule 2's hard requirement — stated for the
 * palette, and true of every dialog in this app.
 */
import { Sheet } from '@/components/ui/sheet';

import { BINDINGS, SCOPES, formatCombo, type ScopeId } from './registry';

/** Declaration order within a scope; scopes in the order a learner meets them. */
const SCOPE_ORDER: ScopeId[] = ['app', 'review'];

export function ShortcutHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} title="Keyboard shortcuts" data-testid="shortcut-help">
      <div className="flex flex-col gap-5">
        {SCOPE_ORDER.map((scope) => {
          const rows = BINDINGS.filter((binding) => binding.scope === scope);
          if (rows.length === 0) return null;
          return (
            <section key={scope} data-testid={`shortcut-group-${scope}`}>
              <h3 className="mb-2 text-sm font-semibold text-muted">{SCOPES[scope].title}</h3>
              <dl className="flex flex-col gap-2">
                {rows.map((binding) => (
                  <div
                    key={binding.id}
                    data-shortcut={binding.id}
                    className="flex items-baseline justify-between gap-4"
                  >
                    <dt className="text-sm">{binding.description}</dt>
                    <dd className="flex shrink-0 gap-1">
                      {binding.keys.map((spec) => (
                        <kbd
                          key={spec}
                          className="rounded border border-border bg-surface px-1.5 py-0.5 font-mono text-xs"
                        >
                          {formatCombo(spec)}
                        </kbd>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          );
        })}
        {/*
          STACK §2.4's sentence, in the place a learner would otherwise form the
          wrong expectation: no browser can register a global hotkey (Chromium
          issue 40749250), so ⌘K reaches the lookup box only when Tangram
          already has focus. Summoning arrives with a desktop application or
          not at all (`wave-zero.md` §10c).
        */}
        <p className="text-xs text-muted">
          These work while Tangram has focus. A browser cannot claim a shortcut
          system-wide, so there is nothing to press when you are somewhere else.
        </p>
      </div>
    </Sheet>
  );
}
