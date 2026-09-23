import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { jwtVerify } from 'jose';

export interface SentPush {
  token: string;
  title: string;
  body: string;
  data: Record<string, string>;
}

/**
 * Contract doubles for the messaging providers, over real HTTP:
 *   - Google OAuth token endpoint (verifies the service-account JWT signature and claims)
 *   - FCM HTTP v1 messages:send (UNREGISTERED for tokens marked invalid)
 *   - MSG91 Flow API (DLT template + variables)
 *   - ZeptoMail send
 */
export class FakeMessaging {
  readonly projectId = 'onetappe-test';
  readonly clientEmail = 'fcm@onetappe-test.iam.gserviceaccount.com';
  readonly msg91AuthKey = 'test-msg91-auth-key';
  readonly zeptoToken = 'test-zeptomail-token';
  readonly privateKeyPem: string;
  private readonly publicKey: KeyObject;

  readonly pushes: SentPush[] = [];
  readonly sms: Array<{ templateId: string; recipient: Record<string, string> }> = [];
  readonly emails: Array<{ to: string; subject: string; text: string }> = [];
  readonly invalidTokens = new Set<string>();
  down = false;
  private issued = new Set<string>();
  private server!: http.Server;
  baseUrl = '';

  private constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    this.publicKey = publicKey;
  }

  static async start(): Promise<FakeMessaging> {
    const fake = new FakeMessaging();
    fake.server = http.createServer((req, res) => {
      void fake.handle(req, res);
    });
    await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
    fake.baseUrl = `http://127.0.0.1:${String((fake.server.address() as AddressInfo).port)}`;
    return fake;
  }

  env(): Record<string, string> {
    return {
      PUSH_PROVIDER: 'fcm',
      SMS_PROVIDER: 'msg91',
      EMAIL_PROVIDER: 'zeptomail',
      WHATSAPP_PROVIDER: 'log',
      FCM_PROJECT_ID: this.projectId,
      FCM_CLIENT_EMAIL: this.clientEmail,
      FCM_PRIVATE_KEY: this.privateKeyPem.replace(/\n/g, '\\n'),
      FCM_API_URL: this.baseUrl,
      GOOGLE_OAUTH_TOKEN_URL: `${this.baseUrl}/token`,
      MSG91_AUTH_KEY: this.msg91AuthKey,
      MSG91_API_URL: this.baseUrl,
      ZEPTOMAIL_API_URL: `${this.baseUrl}/v1.1/email`,
      ZEPTOMAIL_TOKEN: this.zeptoToken,
      EMAIL_FROM_ADDRESS: 'noreply@onetappe.test',
      NOTIFICATION_HTTP_TIMEOUT_MS: '1000',
    };
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (this.down) {
      req.socket.destroy();
      return;
    }
    const body = await new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
    });
    const url = new URL(req.url ?? '/', this.baseUrl);
    const reply = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (url.pathname === '/token') {
      const assertion = new URLSearchParams(body).get('assertion') ?? '';
      try {
        const { payload } = await jwtVerify(assertion, this.publicKey, {
          issuer: this.clientEmail,
          audience: `${this.baseUrl}/token`,
        });
        if (payload['scope'] !== 'https://www.googleapis.com/auth/firebase.messaging') {
          reply(400, { error: 'invalid_scope' });
          return;
        }
      } catch {
        reply(400, { error: 'invalid_grant' });
        return;
      }
      const token = `ya29.test-${String(this.issued.size + 1)}`;
      this.issued.add(token);
      reply(200, { access_token: token, expires_in: 3599, token_type: 'Bearer' });
      return;
    }

    if (url.pathname === `/v1/projects/${this.projectId}/messages:send`) {
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
      if (!bearer || !this.issued.has(bearer)) {
        reply(401, { error: { code: 401, status: 'UNAUTHENTICATED' } });
        return;
      }
      const { message } = JSON.parse(body) as {
        message: {
          token: string;
          notification: { title: string; body: string };
          data: Record<string, string>;
        };
      };
      if (this.invalidTokens.has(message.token)) {
        reply(404, {
          error: {
            code: 404,
            status: 'NOT_FOUND',
            details: [
              {
                '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
                errorCode: 'UNREGISTERED',
              },
            ],
          },
        });
        return;
      }
      this.pushes.push({ token: message.token, ...message.notification, data: message.data });
      reply(200, { name: `projects/${this.projectId}/messages/${String(this.pushes.length)}` });
      return;
    }

    if (url.pathname === '/api/v5/flow') {
      if (req.headers.authkey !== this.msg91AuthKey) {
        reply(200, { type: 'error', message: 'Invalid authkey' });
        return;
      }
      const input = JSON.parse(body) as {
        template_id: string;
        recipients: Array<Record<string, string>>;
      };
      for (const recipient of input.recipients)
        this.sms.push({ templateId: input.template_id, recipient });
      reply(200, { type: 'success', message: `msg91-${String(this.sms.length)}` });
      return;
    }

    if (url.pathname === '/v1.1/email') {
      if (req.headers.authorization !== `Zoho-enczapikey ${this.zeptoToken}`) {
        reply(401, { error: { code: 'TM_3201', message: 'Invalid API token' } });
        return;
      }
      const input = JSON.parse(body) as {
        to: Array<{ email_address: { address: string } }>;
        subject: string;
        textbody: string;
      };
      this.emails.push({
        to: input.to[0]?.email_address.address ?? '',
        subject: input.subject,
        text: input.textbody,
      });
      reply(201, {
        data: [{ code: 'EM_104', message: 'Email request received' }],
        request_id: `zm-${String(this.emails.length)}`,
      });
      return;
    }
    reply(404, {});
  }
}
