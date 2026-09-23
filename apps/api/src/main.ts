import 'reflect-metadata';
import { createApp } from './bootstrap.js';
import { loadEnv } from './config/env.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const app = await createApp(env);
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
}

main().catch((error: unknown) => {
  // Fail fast and visibly; the process supervisor restarts the service.
  console.error('Start-up failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
