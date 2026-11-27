import { createHash } from 'node:crypto';
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
  deliveryId?: string;
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
  unconfigured?: boolean;
  send(message: SmsMessage): Promise<SendResult>;
}

/** Implemented by the email provider adapter. Throw on any delivery failure. */
export interface EmailGateway {
  unconfigured?: boolean;
  send(message: EmailMessage): Promise<SendResult>;
}

/** A disabled channel has no side effects and never supplies a provider receipt. */
export class StubSmsGateway implements SmsGateway {
  readonly unconfigured = true;
  async send(_message: SmsMessage): Promise<SendResult> { throw new Error('SMS provider is not configured'); }
}
export class StubEmailGateway implements EmailGateway {
  readonly unconfigured = true;
  async send(_message: EmailMessage): Promise<SendResult> { throw new Error('Email provider is not configured'); }
}

export const channelAvailability = () => ({
  SMS: env.SMS_PROVIDER === 'twilio' ? Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && (env.TWILIO_FROM || env.TWILIO_MESSAGING_SERVICE_SID))
    : env.SMS_PROVIDER === 'semaphore' && Boolean(env.SEMAPHORE_API_KEY),
  EMAIL: env.EMAIL_PROVIDER === 'smtp' && (env.NODE_ENV !== 'production' || Boolean(process.env.SMTP_URL)),
});

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
      // For provider tracing only. An SMTP Message-ID does not make resends safe.
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
    sms: channelAvailability().SMS ? createSmsProvider()! : new StubSmsGateway(),
    email: channelAvailability().EMAIL ? new SmtpEmailGateway() : new StubEmailGateway(),
  };
}
