import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import type { DeliveryStatus } from '@prisma/client';
import { env } from '../env.js';

export interface SendResult {
  /** Message id returned by the provider; stored on the outreach log. */
  providerMessageId: string;
  /** Set when the provider confirms delivery synchronously. */
  deliveryStatus?: DeliveryStatus;
}

export interface SmsMessage {
  to: string;
  body: string;
}

export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
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

/**
 * Test stub used until the real SMS service is chosen: logs instead of sending
 * and reports the message as delivered.
 */
export class StubSmsGateway implements SmsGateway {
  async send(message: SmsMessage): Promise<SendResult> {
    // eslint-disable-next-line no-console
    console.log(`[sms:stub] to=${mask(message.to)} chars=${message.body.length}`);
    return { providerMessageId: `stub-sms-${randomUUID()}`, deliveryStatus: 'DELIVERED' };
  }
}

/** Test stub used until the real email service is chosen. */
export class StubEmailGateway implements EmailGateway {
  async send(message: EmailMessage): Promise<SendResult> {
    // eslint-disable-next-line no-console
    console.log(`[email:stub] to=${mask(message.to)} subject="${message.subject}"`);
    return { providerMessageId: `stub-email-${randomUUID()}`, deliveryStatus: 'DELIVERED' };
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
    sms: new StubSmsGateway(),
    email: env.EMAIL_PROVIDER === 'smtp' ? new SmtpEmailGateway() : new StubEmailGateway(),
  };
}
