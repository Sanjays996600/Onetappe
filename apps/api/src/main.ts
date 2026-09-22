import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { AppErrorFilter } from './common/app-error.filter.js';
import { loadEnv } from './config/env.js';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
  // Versioned from day one so Android/iOS releases can rely on a stable contract.
  app.setGlobalPrefix('v1');
  app.useGlobalFilters(new AppErrorFilter());
  app.enableShutdownHooks();
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
}

void bootstrap();
