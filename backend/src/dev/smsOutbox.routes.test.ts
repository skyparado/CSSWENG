import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { StubSmsGateway, clearStubSmsOutbox, stubSmsOutbox } from '../reminders/gateway.js';
import { smsOutboxRouter } from './smsOutbox.routes.js';
import { appWith, doctor, secretary } from '../testing/appWith.js';

const asDoctor = appWith('/api/dev/sms-outbox', smsOutboxRouter, doctor);
const asSecretary = appWith('/api/dev/sms-outbox', smsOutboxRouter, secretary);

beforeEach(() => clearStubSmsOutbox());

describe('SMS stub outbox', () => {
  it('keeps what the stub sent, newest first, with the number masked', async () => {
    const sms = new StubSmsGateway();
    await sms.send({ to: '+639175551234', body: 'UERM: you have a visit due on 2026-12-01.', idempotencyKey: 'k1' });
    await sms.send({ to: '+639170000999', body: 'UERM: you have a visit due on 2026-12-02.', idempotencyKey: 'k2' });

    const items = stubSmsOutbox();
    expect(items.map((i) => i.providerMessageId)).toEqual(['stub-sms-k2', 'stub-sms-k1']);
    expect(items[1]).toMatchObject({ to: '**********234', body: 'UERM: you have a visit due on 2026-12-01.' });
    expect(JSON.stringify(items)).not.toContain('5551234');
  });

  it('keeps only the last 50 messages', async () => {
    const sms = new StubSmsGateway();
    for (let i = 0; i < 55; i++) await sms.send({ to: '+639175551234', body: `m${i}`, idempotencyKey: `k${i}` });
    expect(stubSmsOutbox()).toHaveLength(50);
    expect(stubSmsOutbox()[0].body).toBe('m54');
  });

  it('is readable and clearable by the Doctor only', async () => {
    await new StubSmsGateway().send({ to: '+639175551234', body: 'hello', idempotencyKey: 'k' });

    const list = await request(asDoctor).get('/api/dev/sms-outbox');
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);

    expect((await request(asSecretary).get('/api/dev/sms-outbox')).status).toBe(403);

    expect((await request(asDoctor).delete('/api/dev/sms-outbox')).status).toBe(204);
    expect(stubSmsOutbox()).toHaveLength(0);
  });
});
