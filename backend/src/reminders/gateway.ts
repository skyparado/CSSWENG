import { createHash, randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import type { DeliveryStatus } from '@prisma/client';
import { env } from '../env.js';
import { createSmsProvider } from './providers.js';

export interface SendResult {
  /** Message id returned by the provider; stored on the outreach log. */
  providerMessageId: string;
  /** Set when the provider confirms delivery synchronously. */
  deliveryStatus?: DeliveryStatus;
}

export interface SmsMessage {
  to: string;
  body: string;
  /**
   * Stable across retries of one reminder. Pass it to the provider as its
   * idempotency key (header, request id or client reference) when it has one,
   * so a repeated call is not delivered twice.
   */
  idempotencyKey?: string;
}

export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
  /** See SmsMessage.idempotencyKey. */
  idempotencyKey?: string;
  attachments?: Array<{ filename: string; content: Buffer; contentType: string }>;
}

/** Implemented by the SMS provider adapter. Throw on any delivery failure. */
export interface SmsGateway {
  send(message: SmsMessage): Promise<SendResult>;
}

/** Implemented by the email provider adapter. Throw on any delivery failure. */
export interface EmailGateway {
  send(message: EmailMessage): Promise<SendResult>;
}

/** Mask all but the last 3 characters so logs never carry a full contact detail. */
function mask(value: string): string {
  return value.length <= 3 ? '***' : `${'*'.repeat(value.length - 3)}${value.slice(-3)}`;
}

/** One message the SMS stub "sent", kept in memory so it can be shown like Mailpit shows email. */
export interface StubSmsRecord {
  /** Masked: only the last 3 digits. */
  to: string;
  body: string;
  providerMessageId: string;
  sentAt: string;
}

const STUB_OUTBOX_SIZE = 50;
const stubOutbox: StubSmsRecord[] = [];

/** The most recent stub SMS messages, newest first. Process memory only: gone on restart. */
export function stubSmsOutbox(): StubSmsRecord[] {
  return [...stubOutbox].reverse();
}

export function clearStubSmsOutbox(): void {
  stubOutbox.length = 0;
}

/**
 * Test stub used until the real SMS service is chosen: logs instead of sending
 * and reports the message as delivered. It also keeps the last few messages in
 * memory (number masked) for the development SMS outbox (dev/smsOutbox.routes.ts),
 * which plays the part Mailpit plays for email. Reminder text never carries
 * clinical details, so this holds nothing beyond the clinic name and a date.
 */
export class StubSmsGateway implements SmsGateway {
  async send(message: SmsMessage): Promise<SendResult> {
    // eslint-disable-next-line no-console
    console.log(`[sms:stub] to=${mask(message.to)} chars=${message.body.length}`);
    // Like a provider honouring an idempotency key: the same key yields the same id.
    const providerMessageId = `stub-sms-${message.idempotencyKey ?? randomUUID()}`;
    stubOutbox.push({ to: mask(message.to), body: message.body, providerMessageId, sentAt: new Date().toISOString() });
    if (stubOutbox.length > STUB_OUTBOX_SIZE) stubOutbox.shift();
    return { providerMessageId, deliveryStatus: 'DELIVERED' };
  }
}

/** Test stub used until the real email service is chosen. */
export class StubEmailGateway implements EmailGateway {
  async send(message: EmailMessage): Promise<SendResult> {
    // eslint-disable-next-line no-console
    console.log(`[email:stub] to=${mask(message.to)} subject="${message.subject}"`);
    return {
      providerMessageId: `stub-email-${message.idempotencyKey ?? randomUUID()}`,
      deliveryStatus: 'DELIVERED',
    };
  }
}

/** Sends through any SMTP server (SMTP_URL), e.g. Mailpit locally or a provider's SMTP relay. */
export class SmtpEmailGateway implements EmailGateway {
  private transport = nodemailer.createTransport(env.SMTP_URL);

  async send(message: EmailMessage): Promise<SendResult> {
    const info = await this.transport.sendMail({
      from: env.EMAIL_FROM,
      to: message.to,
      subject: message.subject,
      text: message.body,
      attachments: message.attachments,
      // SMTP has no idempotency key, but a stable Message-ID lets the receiving
      // server and the recipient's mailbox recognise a repeat of the same reminder.
      ...(message.idempotencyKey
        ? {
            messageId: `<${createHash('sha256').update(message.idempotencyKey).digest('hex').slice(0, 32)}@reminders.local>`,
          }
        : {}),
    });
    // The server accepted it; delivery or bounce is only known later.
    return { providerMessageId: info.messageId };
  }
}

export interface Gateways {
  sms: SmsGateway;
  email: EmailGateway;
}

/**
 * Gateways for the configured providers. Add a case here when a real provider
 * is chosen (SMS_PROVIDER / EMAIL_PROVIDER in env.ts).
 */
export function createGateways(): Gateways {
  return {
    sms: createSmsProvider() ?? new StubSmsGateway(),
    email: env.EMAIL_PROVIDER === 'smtp' ? new SmtpEmailGateway() : new StubEmailGateway(),
  };
}
