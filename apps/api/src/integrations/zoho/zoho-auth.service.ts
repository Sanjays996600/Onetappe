import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { Clock } from '../../common/clock.js';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { DATABASE } from '../../database/database.module.js';
import type { DB } from '../../database/db.generated.js';
import { DataCipher } from '../../security/crypto.js';
import { IntegrationError } from '../integration-error.js';

/** Refresh this long before expiry so a token never expires mid-request. */
const REFRESH_MARGIN_MS = 5 * 60_000;

/**
 * Zoho OAuth access tokens (server-to-server, refresh-token grant). One token is shared
 * by every instance and kept encrypted in the database; refreshing happens under a row
 * lock, so instances never refresh at the same time (Zoho allows only ten token requests
 * per ten minutes). The refresh token itself never leaves the secret manager/environment.
 */
@Injectable()
export class ZohoAuth {
  private readonly logger = new Logger('ZohoAuth');
  private readonly cipher: DataCipher;

  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    @Inject(ENV) private readonly env: Env,
    private readonly clock: Clock,
  ) {
    this.cipher = new DataCipher(env.DATA_ENCRYPTION_KEY);
  }

  /**
   * A valid access token. Pass `rejected` when Zoho refused a token (401): a fresh one is
   * obtained unless another instance has already replaced it.
   */
  async accessToken(rejected?: string): Promise<string> {
    type Outcome = { token: string } | { failure: IntegrationError };
    const outcome = await this.db.transaction().execute(async (tx): Promise<Outcome> => {
      const row = await tx
        .selectFrom('integration_credential')
        .selectAll()
        .where('provider', '=', 'ZOHO')
        .forUpdate()
        .executeTakeFirstOrThrow();
      const current = row.access_token_encrypted
        ? this.cipher.decrypt(row.access_token_encrypted)
        : null;
      const now = this.clock.now().getTime();
      const fresh =
        current !== null &&
        current !== rejected &&
        row.expires_at !== null &&
        row.expires_at.getTime() - now > REFRESH_MARGIN_MS;
      if (fresh) return { token: current };

      try {
        const issued = await this.requestToken();
        await tx
          .updateTable('integration_credential')
          .set({
            access_token_encrypted: this.cipher.encrypt(issued.accessToken),
            expires_at: new Date(now + issued.expiresInSeconds * 1000),
            api_domain: issued.apiDomain,
            refreshed_at: this.clock.now(),
            last_error: null,
            last_error_at: null,
          })
          .where('provider', '=', 'ZOHO')
          .execute();
        return { token: issued.accessToken };
      } catch (error) {
        const failure =
          error instanceof IntegrationError
            ? error
            : new IntegrationError('RETRYABLE', `Zoho token request failed: ${String(error)}`);
        // Committed with the lock released, so monitoring shows why tokens are failing.
        await tx
          .updateTable('integration_credential')
          .set({ last_error: failure.message.slice(0, 500), last_error_at: this.clock.now() })
          .where('provider', '=', 'ZOHO')
          .execute();
        return { failure };
      }
    });
    if ('failure' in outcome) throw outcome.failure;
    return outcome.token;
  }

  private async requestToken(): Promise<{
    accessToken: string;
    expiresInSeconds: number;
    apiDomain: string | null;
  }> {
    const url = new URL('/oauth/v2/token', this.env.ZOHO_ACCOUNTS_URL);
    const form = new URLSearchParams({
      refresh_token: this.env.ZOHO_REFRESH_TOKEN ?? '',
      client_id: this.env.ZOHO_CLIENT_ID ?? '',
      client_secret: this.env.ZOHO_CLIENT_SECRET ?? '',
      grant_type: 'refresh_token',
    });
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        signal: AbortSignal.timeout(this.env.ZOHO_HTTP_TIMEOUT_MS),
      });
    } catch (error) {
      throw new IntegrationError('RETRYABLE', `Zoho accounts unreachable: ${describe(error)}`);
    }
    if (response.status === 429) {
      throw new IntegrationError('RATE_LIMITED', 'Zoho token requests are rate limited', 429, 600);
    }
    if (response.status >= 500) {
      throw new IntegrationError(
        'RETRYABLE',
        `Zoho accounts HTTP ${String(response.status)}`,
        response.status,
      );
    }
    const body = (await response.json().catch(() => null)) as {
      access_token?: unknown;
      expires_in?: unknown;
      api_domain?: unknown;
      error?: unknown;
    } | null;
    // Zoho reports bad credentials with an `error` field, sometimes with HTTP 200.
    if (!response.ok || !body || typeof body.access_token !== 'string') {
      const reason =
        typeof body?.error === 'string' ? body.error : `HTTP ${String(response.status)}`;
      this.logger.error(`Zoho refused the token request: ${reason}`);
      throw new IntegrationError(
        'CREDENTIALS',
        `Zoho refused the token request (${reason}); check the client and refresh token`,
        response.status,
      );
    }
    return {
      accessToken: body.access_token,
      expiresInSeconds: typeof body.expires_in === 'number' ? body.expires_in : 3600,
      apiDomain: typeof body.api_domain === 'string' ? body.api_domain : null,
    };
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.name === 'TimeoutError' ? 'timed out' : error.message;
  return String(error);
}
