import { Inject, Injectable } from '@nestjs/common';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { IntegrationError } from '../integration-error.js';
import { ZohoHttp } from './zoho-http.js';

interface UpsertResponse {
  data?: Array<{
    code?: string;
    status?: string;
    message?: string;
    action?: string;
    details?: { id?: string | number };
  }>;
}

/**
 * Zoho CRM REST API (v8) upsert: POST {base}/{Module}/upsert with duplicate_check_fields.
 * Keyed on a unique One Tappe id field, so repeating an upsert never creates duplicates.
 * Verified against a local contract double; confirm against the company's CRM before launch.
 */
@Injectable()
export class ZohoCrmClient {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly http: ZohoHttp,
  ) {}

  async upsert(
    module: string,
    record: Record<string, string | number | null>,
    uniqueField: string,
  ): Promise<{ id: string; action: string }> {
    const url = new URL(
      `${this.env.ZOHO_CRM_API_URL.replace(/\/$/, '')}/${encodeURIComponent(module)}/upsert`,
    );
    const response = await this.http.request<UpsertResponse>({
      method: 'POST',
      url,
      body: { data: [record], duplicate_check_fields: [uniqueField] },
    });
    const result = response?.data?.[0];
    const id = result?.details?.id;
    if (result?.status !== 'success' || id === undefined) {
      throw new IntegrationError(
        'PERMANENT',
        `Zoho CRM upsert into ${module} failed: ${result?.code ?? 'no result'} ${result?.message ?? ''}`.trim(),
      );
    }
    return { id: String(id), action: result.action ?? 'unknown' };
  }
}
