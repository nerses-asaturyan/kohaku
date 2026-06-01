import { defineConfig } from 'vitest/config';

// Unit tests are network-free and fast. End-to-end (testnet) flows are exercised
// by scripts/tests gated behind env vars, not run here by default.
// eslint-disable-next-line import/no-default-export
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 10_000,
  },
});
