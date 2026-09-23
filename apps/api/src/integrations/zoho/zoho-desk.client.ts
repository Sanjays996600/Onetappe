import { Inject, Injectable } from '@nestjs/common';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { IntegrationError } from '../integration-error.js';
import { ZohoHttp } from './zoho-http.js';

export interface DeskContactInput {
  readonly firstName: string | null;
  readonly lastName: string;
  readonly mobile: string | null;
  readonly email: string | null;
}

export interface DeskTicketInput {
  readonly subject: string;
  readonly description: string;
  readonly departmentId: string;
  readonly contactId: string;
  readonly priority: string;
  readonly channel: string;
  /** Custom fields by API name (e.g. `cf_onetappe_case_code`). */
  readonly cf: Record<string, string>;
}

export interface DeskTicket {
  readonly id: string;
  readonly ticketNumber: string | null;
  readonly status: string | null;
  readonly statusType: string | null;
  readonly webUrl: string | null;
  readonly resolution: string | null;
}

interface DeskList<T> {
  data?: T[];
}

/**
 * Zoho Desk REST API (v1): `Authorization: Zoho-oauthtoken …` plus the `orgId` header.
 * Base URL per data centre, e.g. https://desk.zoho.in/api/v1 for India.
 * Verified against a local contract double; confirm against the company's Desk account
 * (staging) before launch.
 */
@Injectable()
export class ZohoDeskClient {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly http: ZohoHttp,
  ) {}

  /** Finds a contact by mobile number or email (Desk returns 204 when nothing matches). */
  async findContact(query: { mobile?: string; email?: string }): Promise<string | null> {
    for (const [param, value] of Object.entries(query)) {
      if (!value) continue;
      const found = await this.get<DeskList<{ id: string }>>('/contacts/search', {
        [param === 'mobile' ? 'phone' : 'email']: value,
        limit: '1',
      });
      const id = found?.data?.[0]?.id;
      if (id) return id;
    }
    return null;
  }

  async createContact(input: DeskContactInput): Promise<string> {
    const created = await this.http.request<{ id?: unknown }>({
      method: 'POST',
      url: this.url('/contacts'),
      headers: this.orgHeader(),
      body: {
        lastName: input.lastName,
        ...(input.firstName ? { firstName: input.firstName } : {}),
        ...(input.mobile ? { mobile: input.mobile } : {}),
        ...(input.email ? { email: input.email } : {}),
      },
    });
    return requireId(created, 'contact');
  }

  /** Finds the ticket carrying our reference in a custom field (used before re-creating). */
  async findTicketByField(fieldApiName: string, value: string): Promise<DeskTicket | null> {
    const found = await this.get<DeskList<Record<string, unknown>>>('/tickets/search', {
      customField1: `${fieldApiName}:${value}`,
      limit: '1',
    });
    const first = found?.data?.[0];
    return first ? toTicket(first) : null;
  }

  async createTicket(input: DeskTicketInput): Promise<DeskTicket> {
    const created = await this.http.request<Record<string, unknown>>({
      method: 'POST',
      url: this.url('/tickets'),
      headers: this.orgHeader(),
      body: input,
    });
    requireId(created, 'ticket');
    return toTicket(created ?? {});
  }

  async getTicket(ticketId: string): Promise<DeskTicket | null> {
    try {
      const ticket = await this.get<Record<string, unknown>>(
        `/tickets/${encodeURIComponent(ticketId)}`,
        {},
      );
      return ticket ? toTicket(ticket) : null;
    } catch (error) {
      if (error instanceof IntegrationError && error.httpStatus === 404) return null;
      throw error;
    }
  }

  private get<T>(path: string, query: Record<string, string>): Promise<T | null> {
    const url = this.url(path);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return this.http.request<T>({ method: 'GET', url, headers: this.orgHeader() });
  }

  private url(path: string): URL {
    return new URL(`${this.env.ZOHO_DESK_API_URL.replace(/\/$/, '')}${path}`);
  }

  private orgHeader(): Record<string, string> {
    return { orgId: this.env.ZOHO_DESK_ORG_ID ?? '' };
  }
}

function requireId(body: { id?: unknown } | null, what: string): string {
  const id = body?.id;
  if (typeof id !== 'string' && typeof id !== 'number') {
    throw new IntegrationError('RETRYABLE', `Zoho Desk created a ${what} without returning its id`);
  }
  return String(id);
}

function toTicket(raw: Record<string, unknown>): DeskTicket {
  const text = (key: string): string | null => {
    const value = raw[key];
    return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
  };
  return {
    id: text('id') ?? '',
    ticketNumber: text('ticketNumber'),
    status: text('status'),
    statusType: text('statusType'),
    webUrl: text('webUrl'),
    resolution: text('resolution'),
  };
}
