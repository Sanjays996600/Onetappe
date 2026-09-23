import { ChannelError, postJson, type ChannelSender, type OutboundMessage } from '../channels.js';

export interface ZeptoMailConfig {
  /** Send Mail token from the company's ZeptoMail agent (secret manager). */
  readonly token: string;
  readonly apiUrl: string;
  readonly fromAddress: string;
  readonly fromName: string;
  readonly timeoutMs: number;
}

/**
 * Zoho ZeptoMail (transactional email): POST {api} with `Authorization: Zoho-enczapikey`.
 * Transactional mail goes through ZeptoMail rather than a Zoho Mail mailbox, which is for
 * people's correspondence and has sending limits unsuited to automated messages.
 */
export class ZeptoMailEmailSender implements ChannelSender {
  readonly channel = 'EMAIL' as const;
  readonly provider = 'zeptomail';

  constructor(private readonly config: ZeptoMailConfig) {}

  async send(message: OutboundMessage): Promise<string> {
    const response = await postJson(this.config.apiUrl, {
      headers: {
        authorization: `Zoho-enczapikey ${this.config.token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        from: { address: this.config.fromAddress, name: this.config.fromName },
        to: [{ email_address: { address: message.recipient } }],
        subject: message.title ?? 'One Tappe',
        textbody: message.body,
      }),
      timeoutMs: this.config.timeoutMs,
    });
    if (response.status >= 200 && response.status < 300) {
      const id = (response.body as { request_id?: unknown } | null)?.request_id;
      return typeof id === 'string' ? id : message.notificationId;
    }
    throw new ChannelError(
      response.status === 429 || response.status >= 500 ? 'RETRYABLE' : 'PERMANENT',
      `ZeptoMail refused (HTTP ${String(response.status)})`,
    );
  }
}
