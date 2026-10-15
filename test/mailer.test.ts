import { describe, expect, it, vi } from 'vitest';
import { EmailRefusedError, EmailSendError, MemorySuppressionList, createMailer } from '../src/index.js';
import { FakeProvider } from '../src/testing.js';

const msg = { to: 'Jane.Doe@example.com', subject: 'Hi', text: 'Hello' };
const noSleep = { sleep: async () => {}, jitter: 0 };

describe('mailer', () => {
  it('sends via provider with default from', async () => {
    const p = new FakeProvider();
    const m = createMailer({ provider: p, from: 'Acme <hello@example.com>' });
    const r = await m.send(msg);
    expect(r.provider).toBe('fake');
    expect(p.outbox[0]!.message.from).toBe('Acme <hello@example.com>');
  });

  it('refuses invalid address and empty content', async () => {
    const m = createMailer({ provider: new FakeProvider(), from: 'a@example.com' });
    await expect(m.send({ ...msg, to: 'nope' })).rejects.toMatchObject({ reason: 'invalid-address' });
    await expect(m.send({ to: 'a@example.com', subject: 's' })).rejects.toMatchObject({ reason: 'missing-content' });
  });

  it('requires a from address', async () => {
    const m = createMailer({ provider: new FakeProvider() });
    await expect(m.send(msg)).rejects.toThrow(/from/);
  });

  it('honors the suppression list case-insensitively, with explicit bypass', async () => {
    const s = new MemorySuppressionList();
    s.add('jane.doe@EXAMPLE.com', 'unsubscribed');
    const p = new FakeProvider();
    const m = createMailer({ provider: p, from: 'a@example.com', suppression: s });
    await expect(m.send(msg)).rejects.toBeInstanceOf(EmailRefusedError);
    expect(p.calls).toBe(0);
    await m.send(msg, { bypassSuppression: true });
    expect(p.outbox).toHaveLength(1);
  });

  it('retries transient failures and not permanent ones', async () => {
    const p = new FakeProvider().failNext(2);
    const m = createMailer({ provider: p, from: 'a@example.com', retry: { attempts: 3, ...noSleep } });
    await m.send(msg);
    expect(p.calls).toBe(3);

    const q = new FakeProvider().failNext(1, new EmailSendError('bad request', false, 422));
    const m2 = createMailer({ provider: q, from: 'a@example.com', retry: { attempts: 3, ...noSleep } });
    await expect(m2.send(msg)).rejects.toThrow('bad request');
    expect(q.calls).toBe(1);
  });

  it('gives up after max attempts', async () => {
    const p = new FakeProvider().failNext(5);
    const m = createMailer({ provider: p, from: 'a@example.com', retry: { attempts: 2, ...noSleep } });
    await expect(m.send(msg)).rejects.toThrow();
    expect(p.calls).toBe(2);
  });

  it('honors Retry-After hints', async () => {
    const sleep = vi.fn(async () => {});
    const p = new FakeProvider().failNext(1, new EmailSendError('slow down', true, 429, 1200));
    const m = createMailer({ provider: p, from: 'a@example.com', retry: { sleep } });
    await m.send(msg);
    expect(sleep).toHaveBeenCalledWith(1200);
  });

  it('does not double-send identical content (derived key)', async () => {
    const p = new FakeProvider();
    const m = createMailer({ provider: p, from: 'a@example.com' });
    const a = await m.send(msg);
    const b = await m.send({ ...msg, to: 'jane.doe@example.com' });
    expect(b).toEqual(a);
    expect(p.calls).toBe(1);
    await m.send(msg, { idempotencyScope: 'order-2' });
    expect(p.outbox).toHaveLength(2);
  });

  it('passes the idempotency key to the provider', async () => {
    const p = new FakeProvider();
    await createMailer({ provider: p, from: 'a@example.com' }).send(msg, { idempotencyKey: 'k1' });
    expect(p.outbox[0]!.idempotencyKey).toBe('k1');
  });
});
