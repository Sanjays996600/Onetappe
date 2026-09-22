import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { Public } from '../auth/decorators.js';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/db.generated.js';

@Controller('health')
@Public()
export class HealthController {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  /** Liveness: the process is running. */
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness: the database answers. */
  @Get('ready')
  async ready(): Promise<{ status: 'ok' }> {
    try {
      await sql`SELECT 1`.execute(this.db);
      return { status: 'ok' };
    } catch {
      throw new ServiceUnavailableException('Database unavailable');
    }
  }
}
