import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { Inject } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';
import { Actor, CurrentPrincipal, RequirePermissions } from '../auth/decorators.js';
import { citiesFor, type Principal } from '../auth/principal.js';
import { NotFoundError } from '../common/errors.js';
import { ZodPipe } from '../common/http/zod.pipe.js';
import type { ActionContext } from '../database/action-context.js';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/db.generated.js';
import { inTransaction } from '../database/transaction.js';
import { ServiceabilityService } from '../service-area/serviceability.service.js';
import { assertCityScope, cityOfZone } from './scope.js';

/** True when the runtime's time-zone database knows `tz` (e.g. Asia/Kolkata). */
function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const Reason = z.string().trim().min(5).max(500);
const Lat = z.number().min(-90).max(90);
const Lng = z.number().min(-180).max(180);
const Code = (max: number) => z.string().regex(new RegExp(`^[A-Z0-9_]{2,${String(max)}}$`));

const CityCreate = z
  .object({
    code: Code(20),
    name: z.string().trim().min(2).max(80),
    stateName: z.string().trim().min(2).max(80),
    timeZone: z.string().refine(isTimeZone, 'Unknown time zone'),
    reason: Reason,
  })
  .strict();
const CityUpdate = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    stateName: z.string().trim().min(2).max(80).optional(),
    isActive: z.boolean().optional(),
    reason: Reason,
  })
  .strict();
const ZoneCreate = z
  .object({
    cityId: z.uuid(),
    code: Code(30),
    name: z.string().trim().min(2).max(80),
    centerLat: Lat,
    centerLng: Lng,
    serviceRadiusM: z.number().int().min(100).max(100_000),
    reason: Reason,
  })
  .strict();
const ZoneUpdate = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    centerLat: Lat.optional(),
    centerLng: Lng.optional(),
    serviceRadiusM: z.number().int().min(100).max(100_000).optional(),
    isActive: z.boolean().optional(),
    reason: Reason,
  })
  .strict();
const PincodeCreate = z
  .object({ code: z.string().regex(/^[1-9]\d{5}$/), cityId: z.uuid(), reason: Reason })
  .strict();
const ActiveUpdate = z.object({ isActive: z.boolean(), reason: Reason }).strict();
const LocalityCreate = z
  .object({
    zoneId: z.uuid(),
    pincode: z.string().regex(/^[1-9]\d{5}$/),
    name: z.string().trim().min(2).max(80),
    centerLat: Lat.nullable().default(null),
    centerLng: Lng.nullable().default(null),
    reason: Reason,
  })
  .strict();
const LocalityUpdate = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    isActive: z.boolean().optional(),
    reason: Reason,
  })
  .strict();
const HoursCreate = z
  .object({
    zoneId: z.uuid(),
    serviceId: z.uuid().nullable().default(null),
    weekday: z.number().int().min(1).max(7),
    openMinute: z.number().int().min(0).max(1439),
    closeMinute: z.number().int().min(1).max(1440),
    validFrom: z.iso.datetime().optional(),
    reason: Reason,
  })
  .strict()
  .refine((h) => h.closeMinute > h.openMinute, 'closeMinute must be after openMinute');
const EndBody = z.object({ reason: Reason }).strict();
const ServiceabilityQuery = z.object({
  pincode: z.string().regex(/^[1-9]\d{5}$/),
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  serviceId: z.uuid().optional(),
});

const PERMISSION = 'service_area.manage';

/**
 * Cities, zones, pincodes, localities and operating hours. Nothing is deleted: areas are
 * switched off, hours are ended. Every change carries a reason and is audited by the
 * database; city-scoped roles can only change their own cities.
 */
@Controller('admin/config')
@RequirePermissions(PERMISSION)
export class ServiceAreaConfigController {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    private readonly serviceability: ServiceabilityService,
  ) {}

  @Get('cities')
  cities(@CurrentPrincipal() principal: Principal) {
    const scope = citiesFor(principal, PERMISSION);
    return this.db
      .selectFrom('city')
      .selectAll()
      .$if(scope !== null, (qb) =>
        qb.where('id', 'in', [...(scope ?? []), '00000000-0000-0000-0000-000000000000']),
      )
      .orderBy('name')
      .execute();
  }

  @Post('cities')
  async createCity(
    @Actor() actor: ActionContext,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodPipe(CityCreate)) body: z.infer<typeof CityCreate>,
  ) {
    assertCityScope(principal, PERMISSION, null);
    return inTransaction(this.db, { ...actor, reason: body.reason }, (tx) =>
      tx
        .insertInto('city')
        .values({
          code: body.code,
          name: body.name,
          state_name: body.stateName,
          time_zone: body.timeZone,
        })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }

  @Patch('cities/:id')
  async updateCity(
    @Actor() actor: ActionContext,
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(CityUpdate)) body: z.infer<typeof CityUpdate>,
  ) {
    assertCityScope(principal, PERMISSION, id);
    return inTransaction(this.db, { ...actor, reason: body.reason }, async (tx) => {
      const row = await tx
        .updateTable('city')
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.stateName !== undefined ? { state_name: body.stateName } : {}),
          ...(body.isActive !== undefined ? { is_active: body.isActive } : {}),
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst();
      if (!row) throw new NotFoundError('City', id);
      return row;
    });
  }

  @Get('zones')
  zones(@CurrentPrincipal() principal: Principal, @Query('cityId', ParseUUIDPipe) cityId: string) {
    assertCityScope(principal, PERMISSION, cityId);
    return this.db
      .selectFrom('zone')
      .selectAll()
      .where('city_id', '=', cityId)
      .orderBy('name')
      .execute();
  }

  @Post('zones')
  async createZone(
    @Actor() actor: ActionContext,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodPipe(ZoneCreate)) body: z.infer<typeof ZoneCreate>,
  ) {
    assertCityScope(principal, PERMISSION, body.cityId);
    return inTransaction(this.db, { ...actor, reason: body.reason }, (tx) =>
      tx
        .insertInto('zone')
        .values({
          city_id: body.cityId,
          code: body.code,
          name: body.name,
          center_lat: String(body.centerLat),
          center_lng: String(body.centerLng),
          service_radius_m: body.serviceRadiusM,
        })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }

  @Patch('zones/:id')
  async updateZone(
    @Actor() actor: ActionContext,
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(ZoneUpdate)) body: z.infer<typeof ZoneUpdate>,
  ) {
    assertCityScope(principal, PERMISSION, await cityOfZone(this.db, id));
    return inTransaction(this.db, { ...actor, reason: body.reason }, (tx) =>
      tx
        .updateTable('zone')
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.centerLat !== undefined ? { center_lat: String(body.centerLat) } : {}),
          ...(body.centerLng !== undefined ? { center_lng: String(body.centerLng) } : {}),
          ...(body.serviceRadiusM !== undefined ? { service_radius_m: body.serviceRadiusM } : {}),
          ...(body.isActive !== undefined ? { is_active: body.isActive } : {}),
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }

  @Get('pincodes')
  pincodes(
    @CurrentPrincipal() principal: Principal,
    @Query('cityId', ParseUUIDPipe) cityId: string,
  ) {
    assertCityScope(principal, PERMISSION, cityId);
    return this.db
      .selectFrom('pincode')
      .selectAll()
      .where('city_id', '=', cityId)
      .orderBy('code')
      .execute();
  }

  @Post('pincodes')
  async createPincode(
    @Actor() actor: ActionContext,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodPipe(PincodeCreate)) body: z.infer<typeof PincodeCreate>,
  ) {
    assertCityScope(principal, PERMISSION, body.cityId);
    return inTransaction(this.db, { ...actor, reason: body.reason }, (tx) =>
      tx
        .insertInto('pincode')
        .values({ code: body.code, city_id: body.cityId })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }

  @Patch('pincodes/:code')
  async updatePincode(
    @Actor() actor: ActionContext,
    @CurrentPrincipal() principal: Principal,
    @Param('code') code: string,
    @Body(new ZodPipe(ActiveUpdate)) body: z.infer<typeof ActiveUpdate>,
  ) {
    const pin = await this.db
      .selectFrom('pincode')
      .select('city_id')
      .where('code', '=', code)
      .executeTakeFirst();
    if (!pin) throw new NotFoundError('Pincode', code);
    assertCityScope(principal, PERMISSION, pin.city_id);
    return inTransaction(this.db, { ...actor, reason: body.reason }, (tx) =>
      tx
        .updateTable('pincode')
        .set({ is_active: body.isActive })
        .where('code', '=', code)
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }

  @Get('localities')
  async localities(
    @CurrentPrincipal() principal: Principal,
    @Query('zoneId', ParseUUIDPipe) zoneId: string,
  ) {
    assertCityScope(principal, PERMISSION, await cityOfZone(this.db, zoneId));
    return this.db
      .selectFrom('locality')
      .selectAll()
      .where('zone_id', '=', zoneId)
      .orderBy('name')
      .execute();
  }

  @Post('localities')
  async createLocality(
    @Actor() actor: ActionContext,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodPipe(LocalityCreate)) body: z.infer<typeof LocalityCreate>,
  ) {
    const cityId = await cityOfZone(this.db, body.zoneId);
    assertCityScope(principal, PERMISSION, cityId);
    return inTransaction(this.db, { ...actor, reason: body.reason }, async (tx) => {
      const pin = await tx
        .selectFrom('pincode')
        .select('city_id')
        .where('code', '=', body.pincode)
        .executeTakeFirst();
      if (pin?.city_id !== cityId) throw new NotFoundError('Pincode in this city', body.pincode);
      return tx
        .insertInto('locality')
        .values({
          zone_id: body.zoneId,
          pincode: body.pincode,
          name: body.name,
          center_lat: body.centerLat === null ? null : String(body.centerLat),
          center_lng: body.centerLng === null ? null : String(body.centerLng),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }

  @Patch('localities/:id')
  async updateLocality(
    @Actor() actor: ActionContext,
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(LocalityUpdate)) body: z.infer<typeof LocalityUpdate>,
  ) {
    const locality = await this.db
      .selectFrom('locality')
      .select('zone_id')
      .where('id', '=', id)
      .executeTakeFirst();
    if (!locality) throw new NotFoundError('Locality', id);
    assertCityScope(principal, PERMISSION, await cityOfZone(this.db, locality.zone_id));
    return inTransaction(this.db, { ...actor, reason: body.reason }, (tx) =>
      tx
        .updateTable('locality')
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.isActive !== undefined ? { is_active: body.isActive } : {}),
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }

  /** Answers "can we serve this address?" exactly as the customer app would be told. */
  @Get('serviceability-check')
  async check(@Query(new ZodPipe(ServiceabilityQuery)) query: z.infer<typeof ServiceabilityQuery>) {
    const location = await this.serviceability.resolve(this.db, {
      pincode: query.pincode,
      lat: query.lat,
      lng: query.lng,
      ...(query.serviceId ? { serviceId: query.serviceId } : {}),
    });
    return { serviceable: location !== null, location };
  }

  @Get('operating-hours')
  async hours(
    @CurrentPrincipal() principal: Principal,
    @Query('zoneId', ParseUUIDPipe) zoneId: string,
  ) {
    assertCityScope(principal, PERMISSION, await cityOfZone(this.db, zoneId));
    return this.db
      .selectFrom('operating_hours')
      .selectAll()
      .where('zone_id', '=', zoneId)
      .where((eb) => eb.or([eb('valid_to', 'is', null), eb('valid_to', '>', sql<Date>`now()`)]))
      .orderBy('weekday')
      .orderBy('open_minute')
      .execute();
  }

  @Post('operating-hours')
  async addHours(
    @Actor() actor: ActionContext,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodPipe(HoursCreate)) body: z.infer<typeof HoursCreate>,
  ) {
    assertCityScope(principal, PERMISSION, await cityOfZone(this.db, body.zoneId));
    return inTransaction(this.db, { ...actor, reason: body.reason }, (tx) =>
      tx
        .insertInto('operating_hours')
        .values({
          zone_id: body.zoneId,
          service_id: body.serviceId,
          weekday: body.weekday,
          open_minute: body.openMinute,
          close_minute: body.closeMinute,
          ...(body.validFrom ? { valid_from: new Date(body.validFrom) } : {}),
          created_by: actor.actorUserId,
        })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }

  @Post('operating-hours/:id/end')
  async endHours(
    @Actor() actor: ActionContext,
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(EndBody)) body: z.infer<typeof EndBody>,
  ) {
    const row = await this.db
      .selectFrom('operating_hours')
      .select('zone_id')
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundError('Operating hours', id);
    assertCityScope(principal, PERMISSION, await cityOfZone(this.db, row.zone_id));
    return inTransaction(this.db, { ...actor, reason: body.reason }, (tx) =>
      tx
        .updateTable('operating_hours')
        .set({ valid_to: sql<Date>`now()` })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }
}
