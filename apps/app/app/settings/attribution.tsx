import type { ReactNode } from 'react';

/**
 * A deliberately small Markdown renderer for `data/ATTRIBUTION.md`.
 *
 * The file is hard-wrapped at ~90 columns, so dropping it into a `<pre>` re-wraps
 * every source line into ragged fragments on a phone and shows `##`, `**` and
 * backticks as literal characters — on the one page a user is meant to read. It
 * handles exactly what that file uses: headings, paragraphs, bullet lists, fenced
 * licence texts, rules, and inline code/bold/links. Anything else renders as its
 * own text, which is the right failure for a licence notice.
 */

type Block =
  | { kind: 'heading'; level: 2 | 3; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'code'; text: string }
  | { kind: 'rule' };

/** Hard-wrapped lines are one paragraph; blank lines and list markers break it. */
export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = [];
  const lines = source.split('\n');
  let paragraph: string[] = [];
  let items: string[] = [];

  const flush = () => {
    if (paragraph.length > 0) blocks.push({ kind: 'paragraph', text: paragraph.join(' ') });
    paragraph = [];
    if (items.length > 0) blocks.push({ kind: 'list', items });
    items = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (line.startsWith('```')) {
      flush();
      const body: string[] = [];
      for (i += 1; i < lines.length && !lines[i].startsWith('```'); i += 1) body.push(lines[i]);
      blocks.push({ kind: 'code', text: body.join('\n') });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    if (/^-{3,}$/.test(line.trim())) {
      flush();
      blocks.push({ kind: 'rule' });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: 'heading', level: heading[1].length <= 1 ? 2 : 3, text: heading[2] });
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      if (paragraph.length > 0) flush();
      items.push(bullet[1]);
      continue;
    }
    // A continuation line: it belongs to whichever block is open.
    if (items.length > 0 && /^\s+/.test(line)) items[items.length - 1] += ` ${line.trim()}`;
    else paragraph.push(line.trim());
  }
  flush();
  return blocks;
}

const INLINE = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)]+)\)|<(https?:\/\/[^>]+)>/g;

/** Inline code, bold, links and bare `<https://…>` URLs; everything else is text. */
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  let n = 0;
  for (const match of text.matchAll(INLINE)) {
    const start = match.index;
    if (start > at) out.push(text.slice(at, start));
    const [, code, bold, label, href, url] = match;
    n += 1;
    const nodeKey = `${key}-${n}`;
    if (code !== undefined) {
      out.push(
        <code key={nodeKey} className="font-mono text-[0.95em]">
          {code}
        </code>,
      );
    } else if (bold !== undefined) {
      out.push(
        <strong key={nodeKey} className="font-medium text-foreground">
          {bold}
        </strong>,
      );
    } else {
      const target = href ?? url;
      // A link's label can itself be code: [`cedict-json`](…) is one link, not a
      // link wrapped around two stray backticks.
      const asCode = label ? /^`(.+)`$/.exec(label) : null;
      out.push(
        <a key={nodeKey} href={target} className="text-accent underline underline-offset-2">
          {asCode ? <code className="font-mono text-[0.95em]">{asCode[1]}</code> : (label ?? url)}
        </a>,
      );
    }
    at = start + match[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

export function Attribution({ source }: { source: string }) {
  return (
    <div className="flex flex-col gap-3 text-sm leading-relaxed text-muted">
      {parseMarkdown(source).map((block, i) => {
        const key = `b${i}`;
        switch (block.kind) {
          case 'heading':
            return block.level === 2 ? (
              <h3 key={key} className="mt-2 text-sm font-semibold text-foreground">
                {inline(block.text, key)}
              </h3>
            ) : (
              <h4 key={key} className="mt-2 text-sm font-medium text-foreground">
                {inline(block.text, key)}
              </h4>
            );
          case 'list':
            return (
              <ul key={key} className="flex list-disc flex-col gap-1 pl-5">
                {block.items.map((item, j) => (
                  <li key={`${key}-${j}`}>{inline(item, `${key}-${j}`)}</li>
                ))}
              </ul>
            );
          case 'code':
            return (
              <pre
                key={key}
                className="overflow-x-auto rounded-md border border-border bg-background p-3 font-mono text-xs whitespace-pre-wrap"
              >
                {block.text}
              </pre>
            );
          case 'rule':
            return <hr key={key} className="border-border" />;
          default:
            return <p key={key}>{inline(block.text, key)}</p>;
        }
      })}
    </div>
  );
}
