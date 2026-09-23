import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import type { ActionContext } from '../../database/action-context.js';
import { DATABASE } from '../../database/database.module.js';
import type { DB } from '../../database/db.generated.js';
import { inTransaction } from '../../database/transaction.js';
import { SupportService, type SupportStatus } from '../../support/support.service.js';
import { IntegrationError } from '../integration-error.js';
import type { IntegrationEventType } from '../integration-outbox.service.js';
import { ZohoCrmClient } from './zoho-crm.client.js';
import { ZohoDeskClient, type DeskTicket } from './zoho-desk.client.js';
import { ZohoConfigurationError, ZohoSettings, type ZohoDeskSettings } from './zoho-settings.js';

/** What a delivery did, for the event log. */
export interface SyncOutcome {
  readonly note: string;
}

type Target = 'ZOHO_CRM' | 'ZOHO_DESK';

/**
 * Turns outbox events into Zoho calls. Every handler reads the current state from
 * PostgreSQL at delivery time and is safe to repeat: creations first look for what an
 * earlier (possibly timed-out) attempt created; CRM writes are upserts keyed on our ids.
 */
@Injectable()
export class ZohoSyncService {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    private readonly settings: ZohoSettings,
    private readonly desk: ZohoDeskClient,
    private readonly crm: ZohoCrmClient,
    private readonly support: SupportService,
  ) {}

  async deliver(
    type: IntegrationEventType,
    aggregateId: string,
    context: ActionContext,
  ): Promise<SyncOutcome> {
    try {
      switch (type) {
        case 'DESK_CASE_CREATE':
          return await this.createCaseTicket(aggregateId, context);
        case 'DESK_CASE_PULL':
          return await this.pullCaseTicket(aggregateId, context);
        case 'DESK_SAFETY_CREATE':
          return await this.createSafetyTicket(aggregateId, context);
        case 'CRM_CUSTOMER_SYNC':
          return await this.syncCustomer(aggregateId, context);
        case 'CRM_BOOKING_SYNC':
          return await this.syncBooking(aggregateId, context);
      }
    } catch (error) {
      if (error instanceof ZohoConfigurationError) {
        throw new IntegrationError('CONFIGURATION', error.message);
      }
      throw error;
    }
  }

  // ---- Zoho Desk ----

  private async createCaseTicket(caseId: string, context: ActionContext): Promise<SyncOutcome> {
    const existing = await this.link('ZOHO_DESK', 'support_case', caseId);
    if (existing) return { note: `Ticket ${existing} already linked` };

    const config = await this.settings.desk();
    const supportCase = await this.db
      .selectFrom('support_case as c')
      .innerJoin('app_user as u', 'u.id', 'c.raised_by_user_id')
      .leftJoin('booking as b', 'b.id', 'c.booking_id')
      .leftJoin('service as s', 's.id', 'b.service_id')
      .select([
        'c.id',
        'c.case_code',
        'c.category',
        'c.severity',
        'c.subject',
        'c.description',
        'c.desired_resolution',
        'c.raised_by_role',
        'c.raised_by_user_id',
        'u.full_name',
        'u.phone_e164',
        'u.email',
        'b.booking_code',
        's.code as service_code',
      ])
      .where('c.id', '=', caseId)
      .executeTakeFirst();
    if (!supportCase) throw new IntegrationError('PERMANENT', `Support case ${caseId} not found`);

    // A lost response may have left a ticket behind: find it before creating another.
    const found = await this.desk.findTicketByField(config.fields.caseCode, supportCase.case_code);
    const ticket =
      found ??
      (await this.desk.createTicket({
        subject: `[${supportCase.case_code}] ${supportCase.subject}`.slice(0, 250),
        description: caseDescription(supportCase),
        departmentId: config.departmentId,
        contactId: await this.deskContact(supportCase.raised_by_user_id, supportCase, context),
        priority: config.priorityBySeverity[severityOf(supportCase.severity)],
        channel: 'Web',
        cf: customFields(config, {
          caseCode: supportCase.case_code,
          bookingCode: supportCase.booking_code,
          customerId:
            supportCase.raised_by_role === 'CUSTOMER' ? supportCase.raised_by_user_id : null,
          category: supportCase.category,
          service: supportCase.service_code,
          raisedBy: supportCase.raised_by_role,
        }),
      }));
    await this.saveLink('ZOHO_DESK', 'support_case', caseId, ticket, context);
    return { note: `${found ? 'Found existing' : 'Created'} ticket ${ticket.id}` };
  }

  private async pullCaseTicket(caseId: string, context: ActionContext): Promise<SyncOutcome> {
    const ticketId = await this.link('ZOHO_DESK', 'support_case', caseId);
    if (!ticketId) return { note: 'No linked ticket; nothing to pull' };
    const ticket = await this.desk.getTicket(ticketId);
    if (!ticket) {
      throw new IntegrationError('PERMANENT', `Zoho Desk ticket ${ticketId} no longer exists`);
    }
    const config = await this.settings.desk();
    const status = mapTicketStatus(ticket, config);
    if (!status) return { note: `Ticket status ${ticket.status ?? '?'} not mapped; unchanged` };
    const changed = await this.support.applyExternalStatus(context, caseId, {
      status,
      resolution:
        ticket.resolution ??
        `Resolved by the support team (ticket ${ticket.ticketNumber ?? ticket.id}).`,
      reference: `Zoho Desk ticket ${ticket.ticketNumber ?? ticket.id}`,
    });
    await this.touchLink('ZOHO_DESK', 'support_case', caseId);
    return { note: changed ? `Case set to ${status}` : `Case already ${status}` };
  }

  /**
   * A reference ticket for a safety escalation, only when enabled. It carries codes and
   * severity only; the narrative stays in the One Tappe safety console.
   */
  private async createSafetyTicket(
    incidentId: string,
    context: ActionContext,
  ): Promise<SyncOutcome> {
    const config = await this.settings.desk();
    if (!config.safetyTickets) return { note: 'Safety tickets are disabled in settings' };
    const existing = await this.link('ZOHO_DESK', 'safety_incident', incidentId);
    if (existing) return { note: `Ticket ${existing} already linked` };

    const incident = await this.db
      .selectFrom('safety_incident as i')
      .innerJoin('app_user as u', 'u.id', 'i.reported_by_user_id')
      .leftJoin('booking as b', 'b.id', 'i.booking_id')
      .select([
        'i.incident_code',
        'i.severity',
        'i.category',
        'i.reporter_role',
        'i.reported_by_user_id',
        'u.full_name',
        'u.phone_e164',
        'u.email',
        'b.booking_code',
      ])
      .where('i.id', '=', incidentId)
      .executeTakeFirst();
    if (!incident)
      throw new IntegrationError('PERMANENT', `Safety incident ${incidentId} not found`);

    const found = await this.desk.findTicketByField(config.fields.caseCode, incident.incident_code);
    const ticket =
      found ??
      (await this.desk.createTicket({
        subject: `[${incident.incident_code}] Safety escalation (${incident.severity})`,
        description: [
          `Safety incident ${incident.incident_code} (${incident.category}, ${incident.severity}).`,
          incident.booking_code ? `Booking: ${incident.booking_code}.` : null,
          'Details are restricted to the One Tappe safety console; do not copy them here.',
        ]
          .filter(Boolean)
          .join('\n'),
        departmentId: config.departmentId,
        contactId: await this.deskContact(incident.reported_by_user_id, incident, context),
        priority: config.priorityBySeverity.HIGH,
        channel: 'Web',
        cf: customFields(config, {
          caseCode: incident.incident_code,
          bookingCode: incident.booking_code,
          customerId: null,
          category: 'SAFETY',
          service: null,
          raisedBy: incident.reporter_role,
        }),
      }));
    await this.saveLink('ZOHO_DESK', 'safety_incident', incidentId, ticket, context);
    return { note: `${found ? 'Found existing' : 'Created'} ticket ${ticket.id}` };
  }

  /** The Desk contact for a person, found or created once and then remembered. */
  private async deskContact(
    userId: string,
    person: { full_name: string | null; phone_e164: string | null; email: string | null },
    context: ActionContext,
  ): Promise<string> {
    const linked = await this.link('ZOHO_DESK', 'contact', userId);
    if (linked) return linked;
    const found = await this.desk.findContact({
      mobile: person.phone_e164 ?? undefined,
      email: person.email ?? undefined,
    });
    const { firstName, lastName } = splitName(person.full_name);
    const contactId =
      found ??
      (await this.desk.createContact({
        firstName,
        lastName,
        mobile: person.phone_e164,
        email: person.email,
      }));
    await this.saveLink('ZOHO_DESK', 'contact', userId, { id: contactId }, context);
    return contactId;
  }

  // ---- Zoho CRM ----

  private async syncCustomer(userId: string, context: ActionContext): Promise<SyncOutcome> {
    const config = await this.settings.crm();
    const customer = await this.db
      .selectFrom('app_user as u')
      .innerJoin('customer_profile as c', 'c.user_id', 'u.id')
      .select(['u.full_name', 'u.phone_e164', 'u.email', 'u.preferred_locale', 'u.created_at'])
      .where('u.id', '=', userId)
      .executeTakeFirst();
    if (!customer) throw new IntegrationError('PERMANENT', `Customer ${userId} not found`);
    const { firstName, lastName } = splitName(customer.full_name);
    const result = await this.crm.upsert(
      'Contacts',
      {
        [config.contactIdField]: userId,
        First_Name: firstName,
        Last_Name: lastName,
        Mobile: customer.phone_e164,
        Email: customer.email,
        Lead_Source: 'One Tappe app',
      },
      config.contactIdField,
    );
    await this.saveLink('ZOHO_CRM', 'customer', userId, { id: result.id }, context);
    return { note: `Contact ${result.action} (${result.id})` };
  }

  private async syncBooking(bookingId: string, context: ActionContext): Promise<SyncOutcome> {
    const config = await this.settings.crm();
    if (!config.bookingModule) return { note: 'Booking mirroring is not configured' };
    const booking = await this.db
      .selectFrom('booking as b')
      .innerJoin('service as s', 's.id', 'b.service_id')
      .innerJoin('city as c', 'c.id', 'b.city_id')
      .select([
        'b.booking_code',
        'b.status',
        'b.scheduled_start',
        'b.total_paise',
        'b.customer_user_id',
        's.code as service_code',
        'c.name as city_name',
      ])
      .where('b.id', '=', bookingId)
      .executeTakeFirst();
    if (!booking) throw new IntegrationError('PERMANENT', `Booking ${bookingId} not found`);
    const contactId = await this.link('ZOHO_CRM', 'customer', booking.customer_user_id);
    const fields = config.bookingFields;
    const record: Record<string, string | number | null> = {
      Name: booking.booking_code,
      [config.bookingCodeField]: booking.booking_code,
    };
    if (fields.status) record[fields.status] = booking.status;
    if (fields.scheduledStart)
      record[fields.scheduledStart] = booking.scheduled_start.toISOString();
    if (fields.amount) record[fields.amount] = booking.total_paise / 100;
    if (fields.service) record[fields.service] = booking.service_code;
    if (fields.city) record[fields.city] = booking.city_name;
    if (fields.contactLookup && contactId) record[fields.contactLookup] = contactId;
    const result = await this.crm.upsert(config.bookingModule, record, config.bookingCodeField);
    await this.saveLink('ZOHO_CRM', 'booking', bookingId, { id: result.id }, context);
    return { note: `Booking ${result.action} (${result.id})` };
  }

  // ---- Links ----

  private async link(target: Target, entityType: string, internalId: string) {
    const row = await this.db
      .selectFrom('external_link')
      .select('external_id')
      .where('target', '=', target)
      .where('entity_type', '=', entityType)
      .where('internal_id', '=', internalId)
      .executeTakeFirst();
    return row?.external_id ?? null;
  }

  private async saveLink(
    target: Target,
    entityType: string,
    internalId: string,
    external: Pick<DeskTicket, 'id'> & Partial<Pick<DeskTicket, 'ticketNumber' | 'webUrl'>>,
    context: ActionContext,
  ): Promise<void> {
    await inTransaction(this.db, context, (tx) =>
      tx
        .insertInto('external_link')
        .values({
          target,
          entity_type: entityType,
          internal_id: internalId,
          external_id: external.id,
          external_ref: external.ticketNumber ?? null,
          external_url: external.webUrl ?? null,
        })
        .onConflict((oc) =>
          oc
            .columns(['target', 'entity_type', 'internal_id'])
            .doUpdateSet({ synced_at: sql<Date>`now()` }),
        )
        .execute(),
    );
  }

  private async touchLink(target: Target, entityType: string, internalId: string) {
    await this.db
      .updateTable('external_link')
      .set({ synced_at: sql<Date>`now()` })
      .where('target', '=', target)
      .where('entity_type', '=', entityType)
      .where('internal_id', '=', internalId)
      .execute();
  }
}

function severityOf(value: string): 'LOW' | 'MEDIUM' | 'HIGH' {
  return value === 'LOW' || value === 'HIGH' ? value : 'MEDIUM';
}

function splitName(fullName: string | null): { firstName: string | null; lastName: string } {
  const parts = (fullName ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: null, lastName: 'One Tappe customer' };
  if (parts.length === 1) return { firstName: null, lastName: parts[0] ?? '' };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts.at(-1) ?? '' };
}

function caseDescription(c: {
  case_code: string;
  category: string;
  raised_by_role: string;
  booking_code: string | null;
  service_code: string | null;
  description: string;
  desired_resolution: string | null;
}): string {
  return [
    `One Tappe case ${c.case_code} (${c.category}), raised by the ${c.raised_by_role.toLowerCase()} in the app.`,
    c.booking_code
      ? `Booking: ${c.booking_code}${c.service_code ? ` (${c.service_code})` : ''}`
      : null,
    '',
    c.description,
    c.desired_resolution ? `\nRequested resolution: ${c.desired_resolution}` : null,
  ]
    .filter((line) => line !== null)
    .join('\n');
}

function customFields(
  config: ZohoDeskSettings,
  values: Record<keyof ZohoDeskSettings['fields'], string | null>,
): Record<string, string> {
  const cf: Record<string, string> = {};
  for (const [key, apiName] of Object.entries(config.fields)) {
    const value = values[key as keyof ZohoDeskSettings['fields']];
    if (apiName && value) cf[apiName] = value;
  }
  return cf;
}

/** Desk status → case status: explicit mapping first, then Desk's status type. */
export function mapTicketStatus(
  ticket: DeskTicket,
  config: ZohoDeskSettings,
): SupportStatus | null {
  if (ticket.status && config.statusMap[ticket.status])
    return config.statusMap[ticket.status] ?? null;
  switch (ticket.statusType) {
    case 'Closed':
      return 'RESOLVED';
    case 'On Hold':
      return 'WAITING_ON_CUSTOMER';
    case 'Open':
      return ticket.status === 'Open' ? 'OPEN' : 'IN_PROGRESS';
    default:
      return null;
  }
}
