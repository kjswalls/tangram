import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Node, not jsdom: nothing in this package renders anything.
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
