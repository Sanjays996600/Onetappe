import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { NotFoundError } from '../common/errors.js';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/db.generated.js';
import { TranslationService } from '../i18n/translation.service.js';
import {
  ServiceabilityService,
  type ServiceLocation,
} from '../service-area/serviceability.service.js';

export interface LocationQuery {
  readonly pincode: string;
  readonly lat: number;
  readonly lng: number;
}

/** What is sold where. Everything here is configuration, filtered to active rows. */
@Injectable()
export class CatalogService {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    private readonly serviceability: ServiceabilityService,
    private readonly translations: TranslationService,
  ) {}

  resolve(location: LocationQuery): Promise<ServiceLocation | null> {
    return this.serviceability.resolve(this.db, location);
  }

  /** Categories and services active in the location's zone, with a "from" price. */
  async catalog(location: ServiceLocation, locale: string) {
    const services = await this.db
      .selectFrom('service as s')
      .innerJoin('service_category as c', 'c.id', 's.category_id')
      .innerJoin('service_zone as sz', (join) =>
        join
          .onRef('sz.service_id', '=', 's.id')
          .on('sz.zone_id', '=', location.zoneId)
          .on('sz.is_active', '=', true),
      )
      .select([
        's.id',
        's.code',
        's.name',
        's.description',
        's.duration_minutes',
        's.supports_instant',
        's.supports_scheduled',
        's.category_id',
        'c.code as category_code',
        'c.name as category_name',
        'c.icon_key',
        'c.sort_order as category_sort',
        's.sort_order',
      ])
      .select((eb) =>
        eb
          .selectFrom('price_rule as p')
          .select((sub) => sub.fn.min('p.base_amount_paise').as('m'))
          .whereRef('p.service_id', '=', 's.id')
          .where('p.is_active', '=', true)
          .where('p.valid_from', '<=', sql<Date>`now()`)
          .where((w) => w.or([w('p.valid_to', 'is', null), w('p.valid_to', '>', sql<Date>`now()`)]))
          .where((w) => w.or([w('p.zone_id', 'is', null), w('p.zone_id', '=', location.zoneId)]))
          .where((w) => w.or([w('p.city_id', 'is', null), w('p.city_id', '=', location.cityId)]))
          .as('from_price_paise'),
      )
      .where('s.is_active', '=', true)
      .where('c.is_active', '=', true)
      .orderBy('c.sort_order')
      .orderBy('s.sort_order')
      .execute();

    const translatedServices = await this.translations.apply(
      'service',
      services,
      ['name', 'description'],
      locale,
    );
    const categoryRows = [
      ...new Map(
        services.map((s) => [s.category_id, { id: s.category_id, name: s.category_name }]),
      ).values(),
    ];
    const categories = await this.translations.apply(
      'service_category',
      categoryRows,
      ['name'],
      locale,
    );

    return categories.map((category) => ({
      id: category.id,
      name: category.name,
      services: translatedServices
        .filter((s) => s.category_id === category.id && s.from_price_paise !== null)
        .map((s) => ({
          id: s.id,
          code: s.code,
          name: s.name,
          description: s.description,
          durationMinutes: s.duration_minutes,
          supportsInstant: s.supports_instant,
          supportsScheduled: s.supports_scheduled,
          fromPricePaise: s.from_price_paise,
        })),
    }));
  }

  async service(serviceId: string, locale: string) {
    const service = await this.db
      .selectFrom('service')
      .select([
        'id',
        'code',
        'name',
        'description',
        'duration_minutes',
        'supports_instant',
        'supports_scheduled',
        'min_lead_time_minutes',
        'max_advance_days',
        'workers_required',
      ])
      .where('id', '=', serviceId)
      .where('is_active', '=', true)
      .executeTakeFirst();
    if (!service) throw new NotFoundError('Service', serviceId);
    const [translated] = await this.translations.apply(
      'service',
      [service],
      ['name', 'description'],
      locale,
    );
    const options = await this.db
      .selectFrom('service_option')
      .select(['id', 'code', 'name', 'description', 'duration_minutes', 'is_default'])
      .where('service_id', '=', serviceId)
      .where('is_active', '=', true)
      .orderBy('sort_order')
      .execute();
    const tasks = await this.db
      .selectFrom('service_task')
      .select(['id', 'code', 'name', 'description', 'is_default_selected'])
      .where('service_id', '=', serviceId)
      .where('is_active', '=', true)
      .orderBy('sort_order')
      .execute();
    return {
      id: service.id,
      code: service.code,
      name: translated?.name ?? service.name,
      description: translated?.description ?? service.description,
      durationMinutes: service.duration_minutes,
      supportsInstant: service.supports_instant,
      supportsScheduled: service.supports_scheduled,
      minLeadTimeMinutes: service.min_lead_time_minutes,
      maxAdvanceDays: service.max_advance_days,
      options: (
        await this.translations.apply('service_option', options, ['name', 'description'], locale)
      ).map((o) => ({
        id: o.id,
        code: o.code,
        name: o.name,
        description: o.description,
        durationMinutes: o.duration_minutes ?? service.duration_minutes,
        isDefault: o.is_default,
      })),
      tasks: (
        await this.translations.apply('service_task', tasks, ['name', 'description'], locale)
      ).map((t) => ({
        id: t.id,
        code: t.code,
        name: t.name,
        description: t.description,
        selectedByDefault: t.is_default_selected,
      })),
    };
  }
}
