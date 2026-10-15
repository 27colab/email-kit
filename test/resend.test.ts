import { describe, expect, it, vi } from 'vitest';
import { EmailSendError, ResendProvider } from '../src/index.js';

const message = { from: 'A <a@example.com>', to: 'b@example.com', subject: 'S', text: 'T' };
const ok = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

describe('ResendProvider', () => {
  it('posts the expected payload with auth and idempotency headers', async () => {
    const f = vi.fn(async () => ok({ id: 'abc' }));
    const p = new ResendProvider({ apiKey: 're_test_key', fetch: f as unknown as typeof fetch });
    const r = await p.send(
      { ...message, replyTo: 'r@example.com', tags: { kind: 'x' }, attachments: [{ filename: 'a.txt', content: new TextEncoder().encode('hi'), contentType: 'text/plain' }] },
      { idempotencyKey: 'k' },
    );
    expect(r).toEqual({ id: 'abc', provider: 'resend' });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    const h = init.headers as Record<string, string>;
    expect(h.Authorization).toBe('Bearer re_test_key');
    expect(h['Idempotency-Key']).toBe('k');
    const body = JSON.parse(init.body as string);
    expect(body.to).toEqual(['b@example.com']);
    expect(body.reply_to).toBe('r@example.com');
    expect(body.tags).toEqual([{ name: 'kind', value: 'x' }]);
    expect(body.attachments[0]).toEqual({ filename: 'a.txt', content: 'aGk=', content_type: 'text/plain' });
  });

  it('classifies errors', async () => {
    const mk = (res: Response) => new ResendProvider({ apiKey: 'k', fetch: (async () => res) as unknown as typeof fetch });
    const e429 = await mk(ok({}, 429, { 'retry-after': '2' })).send(message).catch((e) => e);
    expect(e429).toBeInstanceOf(EmailSendError);
    expect(e429).toMatchObject({ retryable: true, status: 429, retryAfterMs: 2000 });
    expect(await mk(ok({}, 503)).send(message).catch((e) => e)).toMatchObject({ retryable: true });
    expect(await mk(ok({}, 422)).send(message).catch((e) => e)).toMatchObject({ retryable: false, status: 422 });
  });

  it('treats network failures as retryable', async () => {
    const p = new ResendProvider({ apiKey: 'k', fetch: (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch });
    expect(await p.send(message).catch((e) => e)).toMatchObject({ retryable: true });
  });

  it('requires an api key', () => {
    expect(() => new ResendProvider({ apiKey: ' ' })).toThrow();
  });
});
