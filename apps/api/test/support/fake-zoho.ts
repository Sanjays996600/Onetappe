import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeTicket {
  id: string;
  ticketNumber: string;
  subject: string;
  description: string;
  departmentId: string;
  contactId: string;
  priority: string;
  status: string;
  statusType: string;
  resolution: string | null;
  cf: Record<string, string>;
}

type Fault =
  | { kind: 'status'; status: number; body?: unknown; headers?: Record<string, string> }
  | { kind: 'drop' } // close the connection without answering
  | { kind: 'drop-after-create' }; // perform the request, then lose the response

/**
 * A contract double of the Zoho APIs One Tappe uses (OAuth token refresh, Desk contacts
 * and tickets, CRM upsert), served over real HTTP so the integration code runs exactly as
 * it would against Zoho. Faults can be injected per request path.
 */
export class FakeZoho {
  readonly clientId = 'test-zoho-client';
  readonly clientSecret = 'test-zoho-client-secret';
  refreshToken = 'test-zoho-refresh-token';
  readonly orgId = '60001';

  readonly tickets = new Map<string, FakeTicket>();
  readonly contacts = new Map<
    string,
    { id: string; lastName: string; mobile?: string; email?: string }
  >();
  readonly crm = new Map<string, Map<string, Record<string, unknown> & { id: string }>>();
  readonly requests: Array<{ method: string; path: string }> = [];
  tokenRequests = 0;
  /** When true every connection is refused (Zoho unreachable). */
  down = false;

  private readonly validTokens = new Set<string>();
  private readonly faults: Array<{ match: RegExp; fault: Fault }> = [];
  private nextId = 1000;
  private server!: http.Server;
  baseUrl = '';

  static async start(): Promise<FakeZoho> {
    const zoho = new FakeZoho();
    zoho.server = http.createServer((req, res) => {
      void zoho.handle(req, res);
    });
    await new Promise<void>((resolve) => zoho.server.listen(0, '127.0.0.1', resolve));
    zoho.baseUrl = `http://127.0.0.1:${String((zoho.server.address() as AddressInfo).port)}`;
    return zoho;
  }

  env(): Record<string, string> {
    return {
      ZOHO_CRM_ENABLED: 'true',
      ZOHO_DESK_ENABLED: 'true',
      ZOHO_ACCOUNTS_URL: this.baseUrl,
      ZOHO_DESK_API_URL: `${this.baseUrl}/desk/api/v1`,
      ZOHO_CRM_API_URL: `${this.baseUrl}/crm/v8`,
      ZOHO_CLIENT_ID: this.clientId,
      ZOHO_CLIENT_SECRET: this.clientSecret,
      ZOHO_REFRESH_TOKEN: this.refreshToken,
      ZOHO_DESK_ORG_ID: this.orgId,
      ZOHO_DESK_WEBHOOK_SECRET: 'test-zoho-desk-webhook-secret-0123456789',
      ZOHO_HTTP_TIMEOUT_MS: '1000',
    };
  }

  /** The next request whose "METHOD /path" matches fails as described. */
  failNext(match: RegExp, fault: Fault): void {
    this.faults.push({ match, fault });
  }

  /** Invalidates every issued access token (as if they expired early). */
  revokeTokens(): void {
    this.validTokens.clear();
  }

  ticketsFor(caseCode: string): FakeTicket[] {
    return [...this.tickets.values()].filter((t) => Object.values(t.cf).includes(caseCode));
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<unknown> {
    if (this.down) {
      req.socket.destroy();
      return;
    }
    const url = new URL(req.url ?? '/', this.baseUrl);
    const signature = `${req.method ?? 'GET'} ${url.pathname}`;
    this.requests.push({ method: req.method ?? 'GET', path: url.pathname });
    const body = await readBody(req);

    const faultIndex = this.faults.findIndex((f) => f.match.test(signature));
    const fault = faultIndex >= 0 ? this.faults.splice(faultIndex, 1)[0]?.fault : undefined;
    if (fault?.kind === 'drop') {
      req.socket.destroy();
      return;
    }
    if (fault?.kind === 'status') {
      res.writeHead(fault.status, { 'content-type': 'application/json', ...fault.headers });
      res.end(JSON.stringify(fault.body ?? { errorCode: 'FAULT', message: 'Injected fault' }));
      return;
    }

    const reply = (status: number, payload?: unknown): true => {
      if (fault?.kind === 'drop-after-create') {
        req.socket.destroy();
        return true;
      }
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(payload === undefined ? '' : JSON.stringify(payload));
      return true;
    };

    if (url.pathname === '/oauth/v2/token' && req.method === 'POST') {
      this.tokenRequests += 1;
      const form = new URLSearchParams(body);
      const ok =
        form.get('grant_type') === 'refresh_token' &&
        form.get('client_id') === this.clientId &&
        form.get('client_secret') === this.clientSecret &&
        form.get('refresh_token') === this.refreshToken;
      // Zoho reports bad credentials with HTTP 200 and an error field.
      if (!ok) return reply(200, { error: 'invalid_code' });
      const token = `tok-${String(this.tokenRequests)}`;
      this.validTokens.add(token);
      return reply(200, {
        access_token: token,
        expires_in: 3600,
        api_domain: 'https://www.zohoapis.in',
        token_type: 'Bearer',
      });
    }

    const token = /^Zoho-oauthtoken (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!token || !this.validTokens.has(token)) {
      return reply(401, { errorCode: 'INVALID_OAUTH', message: 'The OAuth Token is invalid' });
    }

    if (url.pathname.startsWith('/desk/api/v1/')) {
      if (req.headers.orgid !== this.orgId) {
        return reply(400, { errorCode: 'INVALID_DATA', message: 'orgId missing' });
      }
      return this.desk(req.method ?? 'GET', url, body, reply);
    }
    if (url.pathname.startsWith('/crm/v8/')) {
      return this.crmUpsert(url, body, reply);
    }
    return reply(404, { errorCode: 'URL_NOT_FOUND' });
  }

  private desk(
    method: string,
    url: URL,
    body: string,
    reply: (status: number, payload?: unknown) => true,
  ): true {
    const path = url.pathname.replace('/desk/api/v1', '');
    if (method === 'GET' && path === '/contacts/search') {
      const phone = url.searchParams.get('phone');
      const email = url.searchParams.get('email');
      const found = [...this.contacts.values()].filter(
        (c) => (phone && c.mobile === phone) || (email && c.email === email),
      );
      return found.length ? reply(200, { data: found, count: found.length }) : reply(204);
    }
    if (method === 'POST' && path === '/contacts') {
      const input = JSON.parse(body) as { lastName?: string; mobile?: string; email?: string };
      if (!input.lastName) return reply(422, { errorCode: 'INVALID_DATA', message: 'lastName' });
      const contact = {
        id: String(this.nextId++),
        lastName: input.lastName,
        mobile: input.mobile,
        email: input.email,
      };
      this.contacts.set(contact.id, contact);
      return reply(200, contact);
    }
    if (method === 'GET' && path === '/tickets/search') {
      const [field, value] = (url.searchParams.get('customField1') ?? '').split(':');
      const found = [...this.tickets.values()].filter((t) => field && t.cf[field] === value);
      return found.length ? reply(200, { data: found, count: found.length }) : reply(204);
    }
    if (method === 'POST' && path === '/tickets') {
      const input = JSON.parse(body) as Partial<FakeTicket>;
      if (!input.subject || !input.departmentId || !input.contactId) {
        return reply(422, { errorCode: 'INVALID_DATA', message: 'subject/departmentId/contactId' });
      }
      if (!this.contacts.has(input.contactId)) {
        return reply(422, { errorCode: 'INVALID_DATA', message: 'Unknown contactId' });
      }
      const ticket: FakeTicket = {
        id: String(this.nextId++),
        ticketNumber: String(this.nextId++),
        subject: input.subject,
        description: input.description ?? '',
        departmentId: input.departmentId,
        contactId: input.contactId,
        priority: input.priority ?? 'Medium',
        status: 'Open',
        statusType: 'Open',
        resolution: null,
        cf: input.cf ?? {},
      };
      this.tickets.set(ticket.id, ticket);
      return reply(200, { ...ticket, webUrl: `https://desk.example/tickets/${ticket.id}` });
    }
    const ticketMatch = /^\/tickets\/(\d+)$/.exec(path);
    if (method === 'GET' && ticketMatch) {
      const ticket = this.tickets.get(ticketMatch[1] ?? '');
      return ticket ? reply(200, ticket) : reply(404, { errorCode: 'RESOURCE_NOT_FOUND' });
    }
    return reply(404, { errorCode: 'URL_NOT_FOUND' });
  }

  private crmUpsert(url: URL, body: string, reply: (status: number, payload?: unknown) => true) {
    const module = /^\/crm\/v8\/([A-Za-z_]+)\/upsert$/.exec(url.pathname)?.[1];
    if (!module) return reply(404, { code: 'INVALID_URL_PATTERN' });
    const input = JSON.parse(body) as {
      data: Array<Record<string, unknown>>;
      duplicate_check_fields: string[];
    };
    const key = input.duplicate_check_fields[0] ?? '';
    const records =
      this.crm.get(module) ?? new Map<string, Record<string, unknown> & { id: string }>();
    this.crm.set(module, records);
    const data = input.data.map((record) => {
      const keyValue = String(record[key]);
      const existing = records.get(keyValue);
      const id = existing?.id ?? String(this.nextId++);
      records.set(keyValue, { ...existing, ...record, id });
      return {
        code: 'SUCCESS',
        status: 'success',
        action: existing ? 'update' : 'insert',
        message: existing ? 'record updated' : 'record added',
        details: { id },
      };
    });
    return reply(200, { data });
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', () => {
      resolve('');
    });
  });
}
