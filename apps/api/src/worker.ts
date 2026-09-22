import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { loadEnv } from './config/env.js';
import { JobRunner } from './jobs/job-runner.service.js';

/**
 * Background worker process: runs the periodic jobs, no HTTP server. Deploy one or more
 * instances next to the API; job leases keep them from doing the same work twice.
 */
async function main(): Promise<void> {
  loadEnv();
  const app = await NestFactory.createApplicationContext(AppModule);
  app.enableShutdownHooks();
  app.get(JobRunner).start();
}

void main();
