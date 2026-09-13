// @vitest-environment node
// The Anthropic SDK refuses to construct under jsdom (it looks like a browser,
// and a key in a browser is a leaked key). These modules are server-side only.
/**
 * Provider selection (PLAN.md §3.4): the live provider is chosen only when the
 * app is asked for it *and* a key is present.
 */
import { describe, expect, it } from 'vitest';

import { AnthropicProvider, DEFAULT_MODEL } from '@/lib/ai/anthropic';
import { FakeProvider } from '@/lib/ai/fake';
import { selectProvider } from '@/lib/ai/provider';

describe('selectProvider', () => {
  it('is the fake by default', () => {
    expect(selectProvider({}).name).toBe('fake');
    expect(selectProvider({})).toBeInstanceOf(FakeProvider);
  });

  it('is the fake when asked for Anthropic without a key', () => {
    // A half-configured live provider 401s on every ask; an offline answer that
    // works is better.
    expect(selectProvider({ TANGRAM_LLM_PROVIDER: 'anthropic' }).name).toBe('fake');
    expect(selectProvider({ TANGRAM_LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: '   ' }).name).toBe('fake');
  });

  it('is the fake when a key is present but the provider was not asked for', () => {
    expect(selectProvider({ ANTHROPIC_API_KEY: 'sk-test' }).name).toBe('fake');
    expect(selectProvider({ TANGRAM_LLM_PROVIDER: 'fake', ANTHROPIC_API_KEY: 'sk-test' }).name).toBe('fake');
  });

  it('is Anthropic when both halves are set', () => {
    const provider = selectProvider({ TANGRAM_LLM_PROVIDER: 'Anthropic', ANTHROPIC_API_KEY: 'sk-test' });
    expect(provider.name).toBe('anthropic');
    expect(provider).toBeInstanceOf(AnthropicProvider);
    expect((provider as AnthropicProvider).model).toBe(DEFAULT_MODEL);
  });

  it('takes the model from the environment when one is named', () => {
    const provider = selectProvider({
      TANGRAM_LLM_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'sk-test',
      TANGRAM_MODEL: 'claude-haiku-4-5',
    }) as AnthropicProvider;
    expect(provider.model).toBe('claude-haiku-4-5');
  });
});
