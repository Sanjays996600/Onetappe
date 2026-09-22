import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  DATABASE_URL: z.url(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  /** Secret used to derive booking start/complete codes. At least 32 characters. */
  VERIFICATION_CODE_SECRET: z.string().min(32),
});

export type Env = z.infer<typeof EnvSchema>;

/** Parses and validates the environment once at start-up; fails fast on bad config. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
