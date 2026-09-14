/**
 * The primitives' contracts (docs/plans/core.md C1).
 *
 * "Unit tests cover each variant map exactly as `button.tsx`'s current shape
 * allows (render, assert the class contract), so a later refactor cannot
 * silently drop a variant."
 *
 * **The maps are asserted directly, not through the rendered `className`**, and
 * that is the whole difference between a guard and a decoration. A rendered
 * class string always carries the component's base classes, so
 * `expect(className.trim().length).toBeGreaterThan(0)` — which is what this
 * file did first — is trivially true even when `VARIANTS[v]` is the empty
 * string. The C1 review found it; these tests import the records and assert
 * every entry is non-empty and that the entries are distinct, so an emptied or
 * duplicated variant fails here rather than shipping.
 */
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import {
  Button,
  GRADE_SIZES,
  SIZES as BUTTON_SIZES,
  VARIANTS as BUTTON_VARIANTS,
  type ButtonSize,
  type ButtonVariant,
} from '@/components/ui/button';
import { Badge, TONES as BADGE_TONES_MAP, type BadgeTone } from '@/components/ui/badge';
import { Chip, TONES as CHIP_TONES_MAP, type ChipTone } from '@/components/ui/chip';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  TabBar,
  TAB_ACTIVE_CLASS,
  TAB_ITEM_CLASS,
  tabItemClass,
  type TabAccent,
  type TabItem,
} from '@/components/ui/tab-bar';

import { render, screen } from '../render';

const VARIANTS: ButtonVariant[] = ['primary', 'lookup', 'secondary', 'ghost'];
const SIZES: ButtonSize[] = ['sm', 'md', 'lg'];
const BADGE_TONES: BadgeTone[] = ['neutral', 'accent', 'lookup', 'practice', 'new', 'warning'];
const CHIP_TONES: ChipTone[] = ['neutral', 'lookup', 'practice', 'new', 'warning'];

/**
 * Every map is checked the same three ways: it has exactly the keys the union
 * declares, no entry is empty, and no two entries are the same. `duplicates`
 * names the aliases that are allowed to collide.
 */
function expectMapIsWhole(
  map: Record<string, string>,
  keys: readonly string[],
  duplicates: readonly (readonly string[])[] = [],
): void {
  expect(Object.keys(map).sort()).toEqual([...keys].sort());
  for (const key of keys) {
    expect(map[key], `${key} is missing or empty`).toBeTruthy();
    expect(map[key].trim().length, `${key} is empty`).toBeGreaterThan(0);
  }
  const allowed = new Map<string, string>();
  for (const group of duplicates) for (const key of group) allowed.set(key, group[0]);
  const byValue = new Map<string, string>();
  for (const key of keys) {
    const previous = byValue.get(map[key]);
    if (previous !== undefined) {
      // Two keys may share a value only if they were declared as aliases.
      expect(allowed.get(key), `${key} duplicates ${previous}`).toBe(allowed.get(previous));
      expect(allowed.get(key), `${key} duplicates ${previous}`).toBeDefined();
    }
    byValue.set(map[key], key);
  }
}

describe('Button', () => {
  it('the variant map has every variant, none empty, none duplicated', () => {
    expectMapIsWhole(BUTTON_VARIANTS, VARIANTS);
  });

  it('the size maps have every size, none empty, none duplicated', () => {
    expectMapIsWhole(BUTTON_SIZES, SIZES);
    expectMapIsWhole(GRADE_SIZES, SIZES);
  });

  it.each(VARIANTS)('renders variant %s, applying its own map entry', (variant) => {
    const { container } = render(<Button variant={variant}>go</Button>);
    const button = container.querySelector('button');
    expect(button?.getAttribute('data-variant')).toBe(variant);
    // The map entry itself has to be in the class string, not merely some
    // non-empty class string.
    for (const token of BUTTON_VARIANTS[variant].split(/\s+/)) {
      expect(button?.className).toContain(token);
    }
  });

  it('the four variants produce four distinct class strings', () => {
    const seen = new Set(
      VARIANTS.map((variant) => {
        const { container } = render(<Button variant={variant}>go</Button>);
        return container.querySelector('button')?.className ?? '';
      }),
    );
    expect(seen.size).toBe(VARIANTS.length);
  });

  it('primary is vermillion and lookup is jade — the one filled action rule', () => {
    const { container: primary } = render(<Button variant="primary">go</Button>);
    const { container: lookup } = render(<Button variant="lookup">go</Button>);
    expect(primary.querySelector('button')?.className).toContain('bg-practice');
    expect(lookup.querySelector('button')?.className).toContain('bg-lookup');
  });

  it.each(SIZES)('renders size %s, applying its own map entry', (size) => {
    const { container } = render(<Button size={size}>go</Button>);
    for (const token of BUTTON_SIZES[size].split(/\s+/)) {
      expect(container.querySelector('button')?.className).toContain(token);
    }
  });

  it('the grade shape uses the grade size map, not the default one', () => {
    const { container } = render(
      <Button shape="grade" size="md" sub="3 days">
        Got it
      </Button>,
    );
    const className = container.querySelector('button')?.className ?? '';
    for (const token of GRADE_SIZES.md.split(/\s+/)) expect(className).toContain(token);
    expect(className).not.toContain(BUTTON_SIZES.md.split(/\s+/)[0]);
  });

  it('the grade shape is auto-height and carries its second line', () => {
    render(
      <Button shape="grade" sub="3 days">
        Got it
      </Button>,
    );
    const button = screen.getByRole('button');
    expect(button.getAttribute('data-shape')).toBe('grade');
    expect(button.className).toContain('h-auto');
    expect(button.textContent).toContain('Got it');
    expect(button.textContent).toContain('3 days');
  });

  it('the default shape ignores `sub` rather than rendering it unlabelled', () => {
    render(<Button sub="3 days">Got it</Button>);
    expect(screen.getByRole('button').textContent).toBe('Got it');
  });

  it('is type=button by default, so it never submits a form by accident', () => {
    render(<Button>go</Button>);
    expect(screen.getByRole('button').getAttribute('type')).toBe('button');
  });
});

describe('Badge and Chip', () => {
  it('the Badge tone map has every tone, none empty, and one declared alias', () => {
    // `accent` is kept as the name forty-odd call sites already use for jade;
    // `lookup` is the palette's own name for the same pair. That is the ONE
    // duplicate allowed, and naming it here is what stops a second one sneaking
    // in as "probably intentional".
    expectMapIsWhole(BADGE_TONES_MAP, BADGE_TONES, [['accent', 'lookup']]);
  });

  it('the Chip tone map has every tone, none empty, none duplicated', () => {
    expectMapIsWhole(CHIP_TONES_MAP, CHIP_TONES);
  });

  it.each(BADGE_TONES)('Badge tone %s applies its own map entry', (tone) => {
    render(<Badge tone={tone}>x</Badge>);
    const badge = screen.getByText('x');
    expect(badge.getAttribute('data-tone')).toBe(tone);
    for (const token of BADGE_TONES_MAP[tone].split(/\s+/)) {
      expect(badge.className).toContain(token);
    }
  });

  it.each(CHIP_TONES)('Chip tone %s applies its own map entry', (tone) => {
    render(<Chip tone={tone}>x</Chip>);
    const chip = screen.getByText('x');
    expect(chip.getAttribute('data-tone')).toBe(tone);
    for (const token of CHIP_TONES_MAP[tone].split(/\s+/)) {
      expect(chip.className).toContain(token);
    }
  });

  it('a Chip icon is hidden from the accessibility tree', () => {
    render(<Chip icon={<svg data-testid="glyph" />}>offline</Chip>);
    expect(screen.getByTestId('glyph').closest('[aria-hidden]')).not.toBeNull();
  });
});

describe('Field', () => {
  it('points the label at the control and describes it with the help text', () => {
    render(
      <Field label="Your level" help="New words come from this band.">
        {(props) => <Input {...props} />}
      </Field>,
    );
    const input = screen.getByLabelText('Your level');
    const help = screen.getByText('New words come from this band.');
    expect(input.getAttribute('aria-describedby')).toBe(help.id);
    expect(input.getAttribute('aria-invalid')).toBeNull();
  });

  it('marks the control invalid and describes it with BOTH help and error', () => {
    render(
      <Field label="Your level" help="A number." error="That band does not exist.">
        {(props) => <Input {...props} />}
      </Field>,
    );
    const input = screen.getByLabelText('Your level');
    const described = (input.getAttribute('aria-describedby') ?? '').split(' ');
    expect(described).toHaveLength(2);
    expect(described).toContain(screen.getByText('A number.').id);
    expect(described).toContain(screen.getByText('That band does not exist.').id);
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('announces the error as an alert', () => {
    render(<Field label="x" error="bad">{(props) => <Input {...props} />}</Field>);
    expect(screen.getByRole('alert').textContent).toBe('bad');
  });

  it('gives two fields on one page two different ids', () => {
    render(
      <>
        <Field label="One">{(props) => <Input {...props} />}</Field>
        <Field label="Two">{(props) => <Input {...props} />}</Field>
      </>,
    );
    expect(screen.getByLabelText('One').id).not.toBe(screen.getByLabelText('Two').id);
  });
});

describe('TabBar', () => {
  const TABS: TabItem[] = [
    { key: 'look-up', label: 'Look up', accent: 'lookup' },
    { key: 'practice', label: 'Practice', accent: 'practice' },
    { key: 'library', label: 'Library' },
  ];
  const ACCENTS: TabAccent[] = ['neutral', 'lookup', 'practice', 'new'];

  it('marks the active tab with aria-current and no other', async () => {
    const onPick = vi.fn();
    render(
      <TabBar
        items={TABS}
        active="practice"
        renderItem={(item, { active, className }) => (
          <button
            type="button"
            className={className}
            aria-current={active ? 'page' : undefined}
            onClick={() => onPick(item.key)}
          >
            {item.label}
          </button>
        )}
      />,
    );
    expect(screen.getAllByRole('button', { current: 'page' })).toHaveLength(1);
    expect(screen.getByRole('button', { current: 'page' }).textContent).toBe('Practice');

    await userEvent.setup().click(screen.getByRole('button', { name: 'Look up' }));
    expect(onPick).toHaveBeenCalledWith('look-up');
  });

  it('reserves the home-indicator inset on the bar, not on the buttons', () => {
    render(<TabBar items={TABS} renderItem={(item, { className }) => <span className={className}>{item.label}</span>} />);
    const bar = screen.getByTestId('tab-bar');
    expect(bar.className).toContain('pb-[env(safe-area-inset-bottom)]');
    expect(TAB_ITEM_CLASS).not.toContain('safe-area');
  });

  it('the active-accent map has every accent, none empty, none duplicated', () => {
    expectMapIsWhole(TAB_ACTIVE_CLASS, ACCENTS);
  });

  it('paints the active tab in the DESTINATION\'s accent, not one colour for all three', () => {
    // §1 assigns the accents by meaning. A bar that painted whatever tab was
    // active in vermillion would put a permanent vermillion region in the
    // chrome of every screen, next to the one vermillion action it is allowed.
    render(
      <TabBar
        items={TABS}
        active="look-up"
        renderItem={(item, { active, className }) => (
          <span data-testid={`tab-${item.key}`} className={className} aria-current={active ? 'page' : undefined}>
            {item.label}
          </span>
        )}
      />,
    );
    expect(screen.getByTestId('tab-look-up').className).toContain('bg-lookup-soft');
    expect(screen.getByTestId('tab-look-up').className).not.toContain('bg-practice-soft');
    expect(screen.getByTestId('tab-practice').className).toContain('bg-practice-soft');
    // No accent declared → the neutral treatment, not a borrowed one.
    expect(screen.getByTestId('tab-library').className).toBe(tabItemClass());
  });

  it('every tab meets the 44px touch target', () => {
    expect(TAB_ITEM_CLASS).toContain('min-h-11');
  });
});

describe('EmptyState and Skeleton', () => {
  it('EmptyState renders a title, a body and an action', () => {
    render(
      <EmptyState title="Nothing yet" action={<Button size="sm">Add one</Button>}>
        A list is a handful of words.
      </EmptyState>,
    );
    expect(screen.getByTestId('empty-state').textContent).toContain('Nothing yet');
    expect(screen.getByRole('button', { name: 'Add one' })).toBeTruthy();
  });

  it('Skeleton is hidden from the accessibility tree and stops for reduced motion', () => {
    render(<Skeleton />);
    const skeleton = screen.getByTestId('skeleton');
    expect(skeleton.getAttribute('aria-hidden')).toBe('true');
    expect(skeleton.className).toContain('motion-reduce:animate-none');
  });
});
