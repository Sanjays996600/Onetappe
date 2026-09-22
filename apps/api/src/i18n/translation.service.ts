import { Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/db.generated.js';

/**
 * Configurable content (service names, task names, …) is stored in English on the row
 * itself, with other languages in `translation`. Missing translations fall back to English.
 */
@Injectable()
export class TranslationService {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  async apply<T extends { id: string }>(
    entityType: string,
    rows: readonly T[],
    fields: ReadonlyArray<keyof T & string>,
    locale: string,
  ): Promise<T[]> {
    if (locale === 'en' || rows.length === 0) return [...rows];
    const translations = await this.db
      .selectFrom('translation')
      .select(['entity_id', 'field', 'value'])
      .where('entity_type', '=', entityType)
      .where('locale', '=', locale)
      .where(
        'entity_id',
        'in',
        rows.map((r) => r.id),
      )
      .where('field', 'in', [...fields])
      .execute();
    const byKey = new Map(translations.map((t) => [`${t.entity_id}:${t.field}`, t.value]));
    return rows.map((row) => {
      const copy = { ...row };
      for (const field of fields) {
        const value = byKey.get(`${row.id}:${field}`);
        if (value !== undefined) (copy as Record<string, unknown>)[field] = value;
      }
      return copy;
    });
  }
}
