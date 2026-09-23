import { ChannelError, postJson, type ChannelSender, type OutboundMessage } from '../channels.js';

export interface Msg91SmsConfig {
  readonly authKey: string;
  readonly apiUrl: string;
  readonly timeoutMs: number;
}

/**
 * MSG91 Flow API (v5): POST {api}/api/v5/flow. Indian SMS must use DLT-registered
 * templates, so the message is the provider template (notification_template
 * .provider_template_id) filled with our variables — not our own rendered text.
 * MSG91 can answer HTTP 200 with {"type":"error"}; only "success" counts.
 */
export class Msg91SmsSender implements ChannelSender {
  readonly channel = 'SMS' as const;
  readonly provider = 'msg91';

  constructor(private readonly config: Msg91SmsConfig) {}

  async send(message: OutboundMessage): Promise<string> {
    if (!message.providerTemplateId) {
      throw new ChannelError(
        'PERMANENT',
        'No DLT/MSG91 template id configured for this SMS template',
      );
    }
    const response = await postJson(`${this.config.apiUrl.replace(/\/$/, '')}/api/v5/flow`, {
      headers: { authkey: this.config.authKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        template_id: message.providerTemplateId,
        short_url: '0',
        recipients: [{ mobiles: message.recipient.replace(/^\+/, ''), ...message.variables }],
      }),
      timeoutMs: this.config.timeoutMs,
    });
    const body = response.body as { type?: unknown; message?: unknown } | null;
    if (response.status === 200 && body?.type === 'success') {
      return typeof body.message === 'string' ? body.message : message.notificationId;
    }
    const reason = typeof body?.message === 'string' ? body.message.slice(0, 200) : 'no detail';
    throw new ChannelError(
      response.status === 429 || response.status >= 500 ? 'RETRYABLE' : 'PERMANENT',
      `MSG91 SMS refused (HTTP ${String(response.status)}): ${reason}`,
    );
  }
}
