/**
 * The licences page renders `data/ATTRIBUTION.md` as prose, so the hard wrapping
 * in that file must not reach the screen as ragged half-sentences.
 */
import { describe, expect, it } from 'vitest';

import { parseMarkdown } from '@/app/settings/attribution';

describe('parseMarkdown', () => {
  it('joins hard-wrapped lines back into one paragraph', () => {
    const blocks = parseMarkdown('Tangram is generated\nfrom the four\nsources below.\n');
    expect(blocks).toEqual([
      { kind: 'paragraph', text: 'Tangram is generated from the four sources below.' },
    ]);
  });

  it('keeps headings, rules, bullets and fenced licence text apart', () => {
    const blocks = parseMarkdown(
      ['# Title', '', '---', '', '## CC-CEDICT', '', '- one', '  still one', '- two', '', '```', 'MIT License', '', 'verbatim', '```', ''].join('\n'),
    );
    expect(blocks).toEqual([
      { kind: 'heading', level: 2, text: 'Title' },
      { kind: 'rule' },
      { kind: 'heading', level: 3, text: 'CC-CEDICT' },
      { kind: 'list', items: ['one still one', 'two'] },
      { kind: 'code', text: 'MIT License\n\nverbatim' },
    ]);
  });
});
