import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    // Test against workspace sources, never a stale (or missing) build.
    alias: {
      '@': src('./src'),
      '@onetappe/domain': src('../../packages/domain/src/index.ts'),
      '@onetappe/api-client': src('../../packages/api-client/src/index.ts'),
    },
  },
  test: { include: ['src/**/*.test.ts'] },
});
