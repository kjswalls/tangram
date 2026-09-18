import { describe, expect, it } from 'vitest';

describe('scaffold', () => {
  it('runs unit tests in a jsdom environment', () => {
    expect(typeof document).toBe('object');
  });

  it('has a fake IndexedDB available for the db tests', () => {
    expect(typeof indexedDB.open).toBe('function');
  });
});
