import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

const db = vi.hoisted(() => ({
  outreachLog: { updateMany: vi.fn() },
  reminderDelivery: { updateMany: vi.fn() },
}));
vi.mock('../prisma.js', () => ({ prisma: db }));

// Webhook secrets come from the environment; set them before the modules read it.
vi.mock('../env.js', async (orig) => {
  const mod = await orig<typeof import('../env.js')>();
  return {
    ...mod,
    env: {
      ...mod.env,
      TWILIO_AUTH_TOKEN: 'twilio-token',
      PUBLIC_BASE_URL: 'https://emr.example.com',
      SMS_WEBHOOK_SECRET: 'shh-secret',
    },
  };
});

import { SemaphoreSmsGateway, TwilioSmsGateway, toInternationalPh, ProviderError } from './providers.js';
import { smsWebhooksRouter, twilioSignature } from './webhooks.routes.js';
import { errorHandler } from '../http.js';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('toInternationalPh', () => {
  it.each([
    ['0917 555 1234', '+639175551234'],
    ['09175551234', '+639175551234'],
    ['+63 917 555 1234', '+639175551234'],
    ['639175551234', '+639175551234'],
    ['917-555-1234', '+639175551234'],
    ['+1 (415) 555-0100', '+14155550100'],
  ])('turns %s into %s', (raw, expected) => expect(toInternationalPh(raw)).toBe(expected));
});

describe('TwilioSmsGateway', () => {
  const config = { accountSid: 'AC123', authToken: 'tok', from: '+15005550006', statusCallback: 'https://emr.example.com/api/webhooks/sms/twilio' };

  it('posts a form-encoded message with basic auth and returns the message SID', async () => {
    const doFetch = vi.fn().mockResolvedValue(json(201, { sid: 'SM999', status: 'queued' }));
    const result = await new TwilioSmsGateway(config, doFetch).send({ to: '0917 555 1234', body: 'Hello from UERM' });

    expect(result).toEqual({ providerMessageId: 'SM999', deliveryStatus: undefined });
    const [url, init] = doFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from('AC123:tok').toString('base64')}`);
    const body = init.body as URLSearchParams;
    expect(body.get('To')).toBe('+639175551234');
    expect(body.get('From')).toBe('+15005550006');
    expect(body.get('Body')).toBe('Hello from UERM');
    expect(body.get('StatusCallback')).toBe(config.statusCallback);
  });

  it('uses a Messaging Service instead of a From number when configured', async () => {
    const doFetch = vi.fn().mockResolvedValue(json(201, { sid: 'SM1' }));
    await new TwilioSmsGateway({ accountSid: 'AC', authToken: 't', messagingServiceSid: 'MG1' }, doFetch).send({ to: '+639175551234', body: 'x' });
    const body = (doFetch.mock.calls[0][1] as RequestInit).body as URLSearchParams;
    expect(body.get('MessagingServiceSid')).toBe('MG1');
    expect(body.has('From')).toBe(false);
  });

  it('throws on failure, never including the phone number or the text, and flags permanent errors', async () => {
    const doFetch = vi.fn().mockResolvedValue(json(400, { code: 21211, message: "The 'To' number +639175551234 is not a valid phone number." }));
    const err = await new TwilioSmsGateway(config, doFetch).send({ to: '0917 555 1234', body: 'Secret text' }).catch((e) => e);

    expect(err).toBeInstanceOf(ProviderError);
    expect(err.permanent).toBe(true);
    expect(err.message).not.toContain('639175551234');
    expect(err.message).not.toContain('Secret text');
    expect(err.message).toContain('21211');
  });

  it('treats rate limiting and server errors as retryable', async () => {
    for (const status of [429, 500, 503]) {
      const doFetch = vi.fn().mockResolvedValue(json(status, { message: 'slow down' }));
      const err = await new TwilioSmsGateway(config, doFetch).send({ to: '+639175551234', body: 'x' }).catch((e) => e);
      expect(err.permanent).toBe(false);
    }
  });

  it('needs a sender', () => {
    expect(() => new TwilioSmsGateway({ accountSid: 'AC', authToken: 't' })).toThrow(/TWILIO_FROM/);
  });
});

describe('SemaphoreSmsGateway', () => {
  it('posts the key, number and message, and returns the message id', async () => {
    const doFetch = vi.fn().mockResolvedValue(json(200, [{ message_id: 12345, status: 'Pending' }]));
    const result = await new SemaphoreSmsGateway({ apiKey: 'key1', senderName: 'UERMEyes' }, doFetch).send({ to: '09175551234', body: 'Hello' });

    expect(result).toEqual({ providerMessageId: '12345' });
    const [url, init] = doFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.semaphore.co/api/v4/messages');
    const body = init.body as URLSearchParams;
    expect(body.get('apikey')).toBe('key1');
    expect(body.get('number')).toBe('639175551234');
    expect(body.get('sendername')).toBe('UERMEyes');
  });

  it('throws when the provider reports a failure, without echoing the number', async () => {
    const doFetch = vi.fn().mockResolvedValue(json(200, [{ message_id: 1, status: 'Failed' }]));
    const err = await new SemaphoreSmsGateway({ apiKey: 'k' }, doFetch).send({ to: '09175551234', body: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).not.toContain('9175551234');
  });

  it('throws on a non-2xx response', async () => {
    const doFetch = vi.fn().mockResolvedValue(json(401, { message: 'Invalid API key' }));
    await expect(new SemaphoreSmsGateway({ apiKey: 'bad' }, doFetch).send({ to: '09175551234', body: 'x' })).rejects.toThrow(/Invalid API key/);
  });
});

describe('delivery webhooks', () => {
  const app = express();
  app.use(express.json()); // the real app parses JSON globally
  app.use('/api/webhooks/sms', smsWebhooksRouter);
  app.use(errorHandler);

  const url = 'https://emr.example.com/api/webhooks/sms/twilio';
  const post = (params: Record<string, string>, signature?: string) =>
    request(app)
      .post('/api/webhooks/sms/twilio')
      .set('X-Twilio-Signature', signature ?? twilioSignature('twilio-token', url, params))
      .type('form')
      .send(params);

  beforeEach(() => {
    vi.resetAllMocks();
    db.outreachLog.updateMany.mockResolvedValue({ count: 1 });
    db.reminderDelivery.updateMany.mockResolvedValue({ count: 1 });
  });

  it('computes the signature the way Twilio documents it (URL, then params sorted by name)', () => {
    // Worked example from Twilio's request-validation documentation.
    const sig = twilioSignature('12345', 'https://mycompany.com/myapp.php?foo=1&bar=2', {
      Digits: '1234', To: '+18005551212', From: '+14158675310', Caller: '+14158675310', CallSid: 'CA1234567890ABCDE',
    });
    expect(sig).toBe('GvWf1cFY/Q7PnoempGyD5oXAezc=');
  });

  it('records DELIVERED on the outreach row and the send record', async () => {
    const res = await post({ MessageSid: 'SM1', MessageStatus: 'delivered' });
    expect(res.status).toBe(204);
    expect(db.outreachLog.updateMany).toHaveBeenCalledWith({ where: { providerMessageId: 'SM1' }, data: { deliveryStatus: 'DELIVERED' } });
    expect(db.reminderDelivery.updateMany).toHaveBeenCalledWith({ where: { providerMessageId: 'SM1' }, data: { deliveryStatus: 'DELIVERED' } });
  });

  it.each(['failed', 'undelivered'])('records FAILED for %s', async (status) => {
    await post({ MessageSid: 'SM1', MessageStatus: status });
    expect(db.outreachLog.updateMany.mock.calls[0][0].data).toEqual({ deliveryStatus: 'FAILED' });
  });

  it('ignores intermediate statuses', async () => {
    const res = await post({ MessageSid: 'SM1', MessageStatus: 'sent' });
    expect(res.status).toBe(204);
    expect(db.outreachLog.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a wrong or missing signature and changes nothing', async () => {
    expect((await post({ MessageSid: 'SM1', MessageStatus: 'delivered' }, 'forged')).status).toBe(403);
    const none = await request(app).post('/api/webhooks/sms/twilio').type('form').send({ MessageSid: 'SM1', MessageStatus: 'delivered' });
    expect(none.status).toBe(403);
    expect(db.outreachLog.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a body altered after signing', async () => {
    const signed = twilioSignature('twilio-token', url, { MessageSid: 'SM1', MessageStatus: 'failed' });
    expect((await post({ MessageSid: 'SM1', MessageStatus: 'delivered' }, signed)).status).toBe(403);
  });

  describe('generic provider', () => {
    const generic = (secret: string | undefined, body: unknown) =>
      request(app)
        .post(`/api/webhooks/sms/generic${secret ? `?secret=${secret}` : ''}`)
        .send(body as object);

    it('accepts a report with the shared secret', async () => {
      const res = await generic('shh-secret', { providerMessageId: 'abc', status: 'DELIVERED' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ updated: 1 });
      expect(db.outreachLog.updateMany.mock.calls[0][0]).toEqual({ where: { providerMessageId: 'abc' }, data: { deliveryStatus: 'DELIVERED' } });
    });

    it('rejects a wrong or missing secret', async () => {
      expect((await generic('nope', { providerMessageId: 'abc', status: 'DELIVERED' })).status).toBe(403);
      expect((await generic(undefined, { providerMessageId: 'abc', status: 'DELIVERED' })).status).toBe(403);
      expect(db.outreachLog.updateMany).not.toHaveBeenCalled();
    });

    it('rejects a malformed report', async () => {
      expect((await generic('shh-secret', { providerMessageId: 'abc', status: 'MAYBE' })).status).toBe(400);
    });
  });
});
