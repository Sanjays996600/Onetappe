import { Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { ClientApp } from '../auth/principal.js';
import type { ActionContext } from '../database/action-context.js';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/db.generated.js';
import { inTransaction } from '../database/transaction.js';

/** Push-notification devices. A token belongs to whoever registered it most recently. */
@Injectable()
export class DeviceService {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  async register(
    context: ActionContext,
    app: ClientApp,
    device: { platform: 'ANDROID' | 'IOS' | 'WEB'; pushToken: string; appVersion: string | null },
  ): Promise<void> {
    const userId = context.actorUserId ?? '';
    await inTransaction(this.db, context, (tx) =>
      tx
        .insertInto('user_device')
        .values({
          user_id: userId,
          client_app: app,
          platform: device.platform,
          push_token: device.pushToken,
          app_version: device.appVersion,
        })
        .onConflict((oc) =>
          oc.column('push_token').doUpdateSet({
            user_id: userId,
            client_app: app,
            platform: device.platform,
            app_version: device.appVersion,
            last_seen_at: new Date(),
            disabled_at: null,
          }),
        )
        .execute(),
    );
  }
}
