import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  processReminder: vi.fn(),
  findFollowUpsNeedingReminder: vi.fn(),
  enqueueReminder: vi.fn(),
}));

vi.mock('./reminders.service.js', () => ({
  processReminder: mocks.processReminder,
  findFollowUpsNeedingReminder: mocks.findFollowUpsNeedingReminder,
}));
vi.mock('./queue.js', async (orig) => ({
  ...(await orig<typeof import('./queue.js')>()),
  enqueueReminder: mocks.enqueueReminder,
}));

import { handleJob, runScan } from './worker.js';
import { createGateways, StubEmailGateway, StubSmsGateway } from './gateway.js';
import { sendJobOptions } from './queue.js';

const gateways = createGateways();

beforeEach(() => vi.resetAllMocks());

describe('handleJob', () => {
  it('marks the last allowed attempt as final', async () => {
    mocks.processReminder.mockResolvedValue({ status: 'sent', outreachId: 'o1' });
    const job = {
      name: 'send-reminder',
      data: { followUpId: 'f1', channel: 'SMS' },
      opts: { attempts: 5 },
    };

    await handleJob({ ...job, attemptsMade: 3 } as never, gateways);
    await handleJob({ ...job, attemptsMade: 4 } as never, gateways);

    expect(mocks.processReminder.mock.calls[0][2]).toEqual({ isFinalAttempt: false });
    expect(mocks.processReminder.mock.calls[1][2]).toEqual({ isFinalAttempt: true });
  });

  it('treats a job with no retry config as a single, final attempt', async () => {
    await handleJob(
      { name: 'send-reminder', data: {}, opts: {}, attemptsMade: 0 } as never,
      gateways,
    );
    expect(mocks.processReminder.mock.calls[0][2]).toEqual({ isFinalAttempt: true });
  });

  it('runs the scan job', async () => {
    mocks.findFollowUpsNeedingReminder.mockResolvedValue([]);
    await expect(
      handleJob({ name: 'scan-due-follow-ups', data: {}, opts: {}, attemptsMade: 0 } as never, gateways),
    ).resolves.toBe(0);
  });

  it('rejects an unknown job name', async () => {
    await expect(
      handleJob({ name: 'nope', data: {}, opts: {}, attemptsMade: 0 } as never, gateways),
    ).rejects.toThrow(/Unknown reminder job/);
  });
});

describe('runScan', () => {
  it('queues one deduplicated job per follow-up and channel', async () => {
    mocks.findFollowUpsNeedingReminder.mockImplementation(async (channel: string) =>
      channel === 'SMS' ? ['f1', 'f2'] : ['f3'],
    );

    await expect(runScan()).resolves.toBe(3);

    expect(mocks.enqueueReminder.mock.calls).toEqual([
      [{ followUpId: 'f1', channel: 'SMS' }, { dedupe: true }],
      [{ followUpId: 'f2', channel: 'SMS' }, { dedupe: true }],
      [{ followUpId: 'f3', channel: 'EMAIL' }, { dedupe: true }],
    ]);
  });
});

describe('retry policy', () => {
  it('retries with exponential backoff', () => {
    const opts = sendJobOptions();
    expect(opts.attempts).toBeGreaterThan(1);
    expect(opts.backoff).toMatchObject({ type: 'exponential' });
  });
});

describe('stub gateways', () => {
  it('return a provider message id without sending anything', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const sms = await new StubSmsGateway().send({ to: '+639171234567', body: 'hi' });
    const email = await new StubEmailGateway().send({ to: 'a@b.com', subject: 's', body: 'b' });

    expect(sms.providerMessageId).toMatch(/^stub-sms-/);
    expect(email.providerMessageId).toMatch(/^stub-email-/);
    // The full number is never written to the log.
    expect(log.mock.calls.flat().join(' ')).not.toContain('+639171234567');
    log.mockRestore();
  });
});

describe('idempotency key', () => {
  it('passes the BullMQ job id on every retry, so a retry is recognised as the same send', async () => {
    mocks.processReminder.mockResolvedValue({ status: 'sent', outreachId: 'o1' });
    const base = {
      id: 'reminder-f1-SMS',
      name: 'send-reminder',
      data: { followUpId: 'f1', channel: 'SMS' },
      opts: { attempts: 5 },
    };
    await handleJob({ ...base, attemptsMade: 0 } as never, gateways);
    await handleJob({ ...base, attemptsMade: 1 } as never, gateways);

    expect(mocks.processReminder.mock.calls.map((c) => c[2].jobKey)).toEqual([
      'reminder-f1-SMS',
      'reminder-f1-SMS',
    ]);
  });
});
