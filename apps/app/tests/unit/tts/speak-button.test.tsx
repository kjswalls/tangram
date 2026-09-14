/**
 * The block speaker's three states and its stop (docs/plans/core.md C2).
 *
 * The state that matters most here is `unavailable`: headless Chromium has no
 * voices, so it is the only one the e2e suite can observe, and it is the one
 * that has to look deliberate rather than broken. The stop is new at C2 and is
 * the behaviour that replaced the provider's cancel-on-speak.
 */
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import {
  NO_VOICE_LABEL,
  SPEAK_FAILED_LABEL,
  SpeakButton,
} from '@/components/tts/speak-button';

import { FakeProvider } from './fake-provider';
import { act, fireEvent, render, screen, waitFor } from '../render';

describe('SpeakButton', () => {
  it('renders pending, then ready, and speaks the block as ONE utterance', async () => {
    const provider = new FakeProvider();
    const user = userEvent.setup();
    render(<SpeakButton text="打算" provider={provider} />);

    /**
     * **Pending is asserted, not waited past.** `available()` is a promise, so
     * the first paint is always `pending`, and `pending` is the state that
     * renders the wrapper `invisible` — holding its space so the pinyin line
     * does not jump when the answer lands. Every other test in this file waits
     * for `ready` as its first action, which means dropping the class, or
     * changing it to `hidden`, passed the whole suite while every review card
     * and lookup result reflowed on the voice probe.
     */
    expect(screen.getByTestId('speak-button').getAttribute('data-tts-status')).toBe('pending');
    expect(screen.getByTestId('speak-button-wrap').className).toContain('invisible');

    await waitFor(() => {
      expect(screen.getByTestId('speak-button').getAttribute('data-tts-status')).toBe('ready');
    });

    await user.click(screen.getByTestId('speak-button'));
    // One utterance for the whole block — product rule 3. The per-character
    // sequence is `lib/tts/sequence.ts` and C6 mounts it.
    expect(provider.spoken.map((u) => u.text)).toEqual(['打算']);
  });

  it('tap again stops, and does not play it a second time', async () => {
    const provider = new FakeProvider();
    const user = userEvent.setup();
    render(<SpeakButton text="打算" provider={provider} />);
    await waitFor(() => {
      expect(screen.getByTestId('speak-button').getAttribute('data-tts-status')).toBe('ready');
    });

    const button = screen.getByTestId('speak-button');
    await user.click(button);
    provider.start(provider.last.id);
    await waitFor(() => {
      expect(button.getAttribute('data-speaking')).toBe('true');
    });

    await user.click(button);
    // Still exactly one utterance, and nothing is queued.
    expect(provider.spoken).toHaveLength(1);
    expect(provider.queued).toHaveLength(0);
    await waitFor(() => {
      expect(button.getAttribute('data-speaking')).toBe('false');
    });
  });

  it('returns to idle on its own when the utterance ends', async () => {
    const provider = new FakeProvider();
    const user = userEvent.setup();
    render(<SpeakButton text="打算" provider={provider} />);
    await waitFor(() => {
      expect(screen.getByTestId('speak-button').getAttribute('data-tts-status')).toBe('ready');
    });

    const button = screen.getByTestId('speak-button');
    await user.click(button);
    const id = provider.last.id;
    provider.start(id);
    provider.end(id);
    await waitFor(() => {
      expect(button.getAttribute('data-speaking')).toBe('false');
    });
  });

  it('stops whatever else was speaking before it starts', async () => {
    const provider = new FakeProvider();
    const user = userEvent.setup();
    const other = provider.speak('明天');
    render(<SpeakButton text="打算" provider={provider} />);
    await waitFor(() => {
      expect(screen.getByTestId('speak-button').getAttribute('data-tts-status')).toBe('ready');
    });

    await user.click(screen.getByTestId('speak-button'));
    // The cancel that used to live inside `speak()`: two taps on two cards
    // must not play two words back to back.
    await expect(other.done).resolves.toBe('cancelled');
  });

  it('stops the audio when it unmounts mid-utterance', async () => {
    const provider = new FakeProvider();
    const user = userEvent.setup();
    const { unmount } = render(<SpeakButton text="打算" provider={provider} />);
    await waitFor(() => {
      expect(screen.getByTestId('speak-button').getAttribute('data-tts-status')).toBe('ready');
    });

    await user.click(screen.getByTestId('speak-button'));
    const utterance = provider.last;
    unmount();
    await expect(utterance.done).resolves.toBe('cancelled');
  });

  it('renders the unavailable state with its reason as visible text', async () => {
    const provider = new FakeProvider({ voiceless: true });
    render(<SpeakButton text="打算" provider={provider} />);

    await waitFor(() => {
      expect(screen.getByTestId('speak-button').getAttribute('data-tts-status')).toBe(
        'unavailable',
      );
    });
    // Visible text, not only a `title`: a touch screen never shows a title.
    expect(screen.getByText(NO_VOICE_LABEL)).toBeTruthy();
    expect(screen.getByTestId('speak-button')).toBeDisabled();
  });

  it('cannot be pressed in ANY state but ready, and speaks nothing if it is', async () => {
    /**
     * What actually holds this up is the `disabled` attribute, and this test
     * says so rather than pretending otherwise.
     *
     * The previous version clicked the disabled button and asserted
     * `provider.spoken` was empty — which React guarantees on its own: it does
     * not deliver a synthetic click for a disabled form control, so neither
     * `HTMLElement.click()` nor `fireEvent.click` reaches `onClick`. Deleting
     * the component's `if (disabled) return;` guard left that test green, and
     * it is still green with the guard gone today. So the enforceable claim is
     * the one asserted here: **the button carries `disabled` in every state
     * but `ready`**, which is what makes the press impossible in the first
     * place. The guard in `toggle` stays as a second line of defence for the
     * day the `disabled` attribute is replaced by `aria-disabled` — the usual
     * fix for "a disabled button is neither focusable nor hoverable", which is
     * the complaint this component's own header makes — and on that day this
     * test is the one that has to be rewritten, deliberately.
     */
    const provider = new FakeProvider({ voiceless: true });
    render(<SpeakButton text="打算" provider={provider} />);

    // pending: disabled before the probe has answered.
    expect(screen.getByTestId('speak-button').getAttribute('data-tts-status')).toBe('pending');
    expect(screen.getByTestId('speak-button')).toBeDisabled();

    await waitFor(() => {
      expect(screen.getByTestId('speak-button').getAttribute('data-tts-status')).toBe(
        'unavailable',
      );
    });
    expect(screen.getByTestId('speak-button')).toBeDisabled();

    fireEvent.click(screen.getByTestId('speak-button'));
    expect(provider.spoken).toHaveLength(0);
  });

  it('says so when an utterance fails, rather than returning to Play in silence', async () => {
    const provider = new FakeProvider();
    const user = userEvent.setup();
    render(<SpeakButton text="打算" provider={provider} />);
    await waitFor(() => {
      expect(screen.getByTestId('speak-button').getAttribute('data-tts-status')).toBe('ready');
    });

    await user.click(screen.getByTestId('speak-button'));
    expect(screen.queryByTestId('speak-failed')).toBeNull();

    await act(async () => {
      provider.fail(provider.last.id, 'synthesis-failed');
      await Promise.resolve();
    });

    expect(screen.getByTestId('speak-failed').textContent).toBe(SPEAK_FAILED_LABEL);
    // And it is not stuck on Stop.
    expect(screen.getByTestId('speak-button').getAttribute('data-speaking')).toBe('false');

    // A fresh press clears it before trying again.
    await user.click(screen.getByTestId('speak-button'));
    expect(screen.queryByTestId('speak-failed')).toBeNull();
  });

  it('says nothing when the learner cancels it themselves', async () => {
    const provider = new FakeProvider();
    const user = userEvent.setup();
    render(<SpeakButton text="打算" provider={provider} />);
    await waitFor(() => {
      expect(screen.getByTestId('speak-button').getAttribute('data-tts-status')).toBe('ready');
    });

    await user.click(screen.getByTestId('speak-button'));
    await user.click(screen.getByTestId('speak-button'));
    await act(async () => {
      await Promise.resolve();
    });
    // `'cancelled'` is the learner's own second tap. Reporting it as a failure
    // would make the stop button accuse itself.
    expect(screen.queryByTestId('speak-failed')).toBeNull();
  });

  it('asks again when the voice list loads after the mount', async () => {
    // Chrome's cold-start window: `getVoices()` is empty when the button
    // mounts and populates later. Asked once, this speaker said "No voice" for
    // the life of the mount while the next card's worked.
    const provider = new FakeProvider({ voiceless: true });
    render(<SpeakButton text="打算" provider={provider} />);
    await waitFor(() => {
      expect(screen.getByTestId('speak-button').getAttribute('data-tts-status')).toBe(
        'unavailable',
      );
    });

    await act(async () => {
      provider.loadVoices();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByTestId('speak-button').getAttribute('data-tts-status')).toBe('ready');
    });
    expect(screen.queryByText(NO_VOICE_LABEL)).toBeNull();
  });

  it('unsubscribes from the voice list when it unmounts', async () => {
    const provider = new FakeProvider({ voiceless: true });
    const { unmount } = render(<SpeakButton text="打算" provider={provider} />);
    await waitFor(() => {
      expect(screen.getByTestId('speak-button').getAttribute('data-tts-status')).toBe(
        'unavailable',
      );
    });
    expect(provider.voicesChangedListeners).toBe(1);
    unmount();
    expect(provider.voicesChangedListeners).toBe(0);
  });
});
