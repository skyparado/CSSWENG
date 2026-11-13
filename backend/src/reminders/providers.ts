import { env } from '../env.js';
import type { SendResult, SmsGateway, SmsMessage } from './gateway.js';

/**
 * Real SMS providers. The clinic has not chosen one yet, so SMS_PROVIDER stays
 * "stub" until it does; each adapter below is ready to switch on with its
 * credentials. Both implement the same SmsGateway interface the reminder worker
 * already uses, throw on any delivery failure so BullMQ retries, and never put a
 * phone number or message text in an error message (RA 10173).
 */

type Fetch = typeof fetch;

/**
 * Philippine mobile numbers as people type them ("0917 555 1234", "+63 917...",
 * "639175551234") to international format ("+639175551234"). Anything else that
 * already starts with "+" is kept, minus separators.
 */
export function toInternationalPh(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.startsWith('09') && digits.length === 11) return `+63${digits.slice(1)}`;
  if (digits.startsWith('639') && digits.length === 12) return `+${digits}`;
  if (digits.startsWith('9') && digits.length === 10) return `+63${digits}`;
  return digits;
}

export class ProviderError extends Error {
  constructor(
    public provider: string,
    message: string,
    /** True for errors a retry cannot fix (bad number, bad credentials). */
    public permanent = false,
  ) {
    super(`${provider}: ${message}`);
    this.name = 'ProviderError';
  }
}

/* ---------------------------------- Twilio ---------------------------------- */

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  from?: string;
  messagingServiceSid?: string;
  /** Where Twilio posts delivery reports, e.g. https://emr.example.com/api/webhooks/sms/twilio */
  statusCallback?: string;
}

/**
 * Twilio Programmable Messaging. Twilio has no idempotency header for messages,
 * so a repeat of the same call WOULD send twice; the ReminderDelivery record is
 * what prevents that (see reminders.service.ts).
 */
export class TwilioSmsGateway implements SmsGateway {
  constructor(
    private config: TwilioConfig,
    private doFetch: Fetch = fetch,
  ) {
    if (!config.from && !config.messagingServiceSid) {
      throw new Error('Twilio needs TWILIO_FROM or TWILIO_MESSAGING_SERVICE_SID');
    }
  }

  async send(message: SmsMessage): Promise<SendResult> {
    const body = new URLSearchParams({ To: toInternationalPh(message.to), Body: message.body });
    if (this.config.messagingServiceSid) body.set('MessagingServiceSid', this.config.messagingServiceSid);
    else body.set('From', this.config.from as string);
    if (this.config.statusCallback) body.set('StatusCallback', this.config.statusCallback);

    const res = await this.doFetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.config.accountSid)}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.config.accountSid}:${this.config.authToken}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      },
    );
    const data = (await res.json().catch(() => ({}))) as { sid?: string; status?: string; message?: string; code?: number };
    if (!res.ok || !data.sid) {
      // 4xx other than rate limiting (429) will not succeed on retry.
      throw new ProviderError('twilio', `HTTP ${res.status}${data.code ? ` (code ${data.code})` : ''}: ${data.message ?? 'send failed'}`.replace(/\+?\d{9,}/g, '[number]'), res.status >= 400 && res.status < 500 && res.status !== 429);
    }
    // "queued" / "sent" are not delivery: the status callback reports "delivered".
    return { providerMessageId: data.sid, deliveryStatus: data.status === 'delivered' ? 'DELIVERED' : undefined };
  }
}

/* -------------------------------- Semaphore --------------------------------- */

export interface SemaphoreConfig {
  apiKey: string;
  senderName?: string;
}

/** Semaphore (a Philippine SMS gateway). It has no delivery callbacks; use the generic webhook or poll if needed. */
export class SemaphoreSmsGateway implements SmsGateway {
  constructor(
    private config: SemaphoreConfig,
    private doFetch: Fetch = fetch,
  ) {}

  async send(message: SmsMessage): Promise<SendResult> {
    const body = new URLSearchParams({
      apikey: this.config.apiKey,
      number: toInternationalPh(message.to).replace(/^\+/, ''),
      message: message.body,
    });
    if (this.config.senderName) body.set('sendername', this.config.senderName);

    const res = await this.doFetch('https://api.semaphore.co/api/v4/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const data = (await res.json().catch(() => null)) as
      | Array<{ message_id?: number | string; status?: string }>
      | { message?: string }
      | null;
    const first = Array.isArray(data) ? data[0] : undefined;
    if (!res.ok || !first?.message_id || /fail|reject/i.test(first.status ?? '')) {
      throw new ProviderError('semaphore', `HTTP ${res.status}: ${(!Array.isArray(data) && data?.message) || first?.status || 'send failed'}`.replace(/\+?\d{9,}/g, '[number]'), res.status >= 400 && res.status < 500 && res.status !== 429);
    }
    return { providerMessageId: String(first.message_id) };
  }
}

/** The configured SMS gateway, or a clear startup error if its credentials are missing. */
export function createSmsProvider(): SmsGateway | undefined {
  if (env.SMS_PROVIDER === 'twilio') {
    if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
      throw new Error('SMS_PROVIDER=twilio needs TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN');
    }
    return new TwilioSmsGateway({
      accountSid: env.TWILIO_ACCOUNT_SID,
      authToken: env.TWILIO_AUTH_TOKEN,
      from: env.TWILIO_FROM,
      messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID,
      statusCallback: env.PUBLIC_BASE_URL ? `${env.PUBLIC_BASE_URL}/api/webhooks/sms/twilio` : undefined,
    });
  }
  if (env.SMS_PROVIDER === 'semaphore') {
    if (!env.SEMAPHORE_API_KEY) throw new Error('SMS_PROVIDER=semaphore needs SEMAPHORE_API_KEY');
    return new SemaphoreSmsGateway({ apiKey: env.SEMAPHORE_API_KEY, senderName: env.SEMAPHORE_SENDER_NAME });
  }
  return undefined;
}
