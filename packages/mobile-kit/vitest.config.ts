import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    // Test against workspace sources, never a stale (or missing) build.
    alias: {
      '@onetappe/domain': src('../domain/src/index.ts'),
      '@onetappe/api-client': src('../api-client/src/index.ts'),
    },
  },
  test: { include: ['src/**/*.test.ts'] },
});
