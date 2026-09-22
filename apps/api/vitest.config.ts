import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // SWC emits the decorator metadata NestJS dependency injection relies on.
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    globalSetup: ['test/support/global-setup.ts'],
    setupFiles: ['test/support/env.ts'],
    // Integration tests share one database.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
