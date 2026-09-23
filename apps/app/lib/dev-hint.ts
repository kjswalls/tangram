/**
 * A sentence for the learner, with a hint for whoever runs the server appended
 * only in a development build.
 *
 * The three "offline" disclosures (the ask panel, the card back's sentences,
 * free recall's suggestion) used to end "— set ANTHROPIC_API_KEY for …" in
 * every build. A deployment whose server has no key serves the fake provider
 * on purpose (`packages/ai/provider.ts`, `selectProvider`), so the learner
 * was being told to set an environment variable (first-run audit, HANDOFF.md
 * 2026-09-23). The disclosure itself stays in every build — it is PLAN.md
 * §3.4's "visible as a property of the UI" — and only the operator's half is
 * dropped from production.
 */
export function withDevHint(text: string, hint: string, dev: boolean = import.meta.env.DEV): string {
  return dev ? `${text}${hint}` : text;
}
