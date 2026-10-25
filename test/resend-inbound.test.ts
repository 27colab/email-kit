import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { InboundError, ResendInboundProvider, verifyResendWebhook } from '../src/index.js';
import { FakeInboundProvider, inboundFixtures } from '../src/testing.js';

const secretKey = Buffer.from('0123456789abcdef0123456789abcdef');
const secret = `whsec_${secretKey.toString('base64')}`;
const now = () => new Date(1_800_000_000_000);

function sign(body: string, id = 'msg_1', ts = String(Math.floor(now().getTime() / 1000))) {
  const sig = createHmac('sha256', secretKey).update(`${id}.${ts}.${body}`).digest('base64');
  return { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` };
}

const event = {
  type: 'email.received',
  created_at: '2026-10-23T15:00:00.000Z',
  data: {
    email_id: '56761188-7520-42d8-8898-ff6fc54ce618',
    created_at: '2026-10-23T15:00:00.000Z',
    from: 'Ana García <ana@example.com>',
    to: ['hello@example.com'],
    cc: [],
    bcc: [],
    received_for: ['hello@example.com'],
    message_id: '<reply-1@mail.example.com>',
    subject: 'Re: Your quote',
    attachments: [{ id: 'att_1', filename: 'avatar.png', content_type: 'image/png', content_disposition: 'inline', content_id: '<avatar>' }],
  },
};

const received = {
  object: 'email',
  id: event.data.email_id,
  from: event.data.from,
  to: ['hello@example.com'],
  cc: null,
  bcc: null,
  reply_to: ['ana.reply@example.com'],
  subject: 'Re: Your quote',
  text: 'Thanks, Friday works.\n\nOn Thu, Acme <hello@example.com> wrote:\n> quote',
  html: '<p>Thanks, Friday works.</p>',
  headers: { 'Message-ID': '<reply-1@mail.example.com>', References: '<quote-1@example.com>', 'In-Reply-To': '<quote-1@example.com>', 'Auto-Submitted': 'no' },
  message_id: '<reply-1@mail.example.com>',
  created_at: '2026-10-23T15:00:00.000Z',
  attachments: [{ id: 'att_1', filename: 'avatar.png', content_type: 'image/png', content_disposition: 'inline', content_id: '<avatar>', size: 1234 }],
};

describe('verifyResendWebhook', () => {
  const body = JSON.stringify(event);

  it('accepts a valid signature, including one among several', () => {
    const headers = sign(body);
    expect(() => verifyResendWebhook({ body, headers }, { secret, now })).not.toThrow();
    const multi = { ...headers, 'svix-signature': `v1,AAAA ${headers['svix-signature']}` };
    expect(() => verifyResendWebhook({ body, headers: multi }, { secret, now })).not.toThrow();
    // Standard Webhooks header names and array-valued headers are accepted too
    const std = { 'webhook-id': headers['svix-id'], 'Webhook-Timestamp': [headers['svix-timestamp']], 'WEBHOOK-SIGNATURE': headers['svix-signature'] };
    expect(() => verifyResendWebhook({ body, headers: std }, { secret, now })).not.toThrow();
  });

  it('rejects a tampered body, a wrong secret, and missing headers', () => {
    const headers = sign(body);
    const err = (fn: () => void) => { try { fn(); } catch (e) { return e as InboundError; } return undefined; };
    expect(err(() => verifyResendWebhook({ body: body + ' ', headers }, { secret, now }))).toMatchObject({ reason: 'bad-signature' });
    expect(err(() => verifyResendWebhook({ body, headers }, { secret: 'whsec_AAAA', now }))).toMatchObject({ reason: 'bad-signature' });
    expect(err(() => verifyResendWebhook({ body, headers: {} }, { secret, now }))).toMatchObject({ reason: 'bad-signature' });
  });

  it('rejects stale and malformed timestamps', () => {
    const old = sign(body, 'msg_1', String(Math.floor(now().getTime() / 1000) - 600));
    expect(() => verifyResendWebhook({ body, headers: old }, { secret, now })).toThrow(/tolerance/);
    expect(() => verifyResendWebhook({ body, headers: old }, { secret, now, toleranceMs: 3_600_000 })).not.toThrow();
    expect(() => verifyResendWebhook({ body, headers: { ...old, 'svix-timestamp': 'x' } }, { secret, now })).toThrow(/not a number/);
  });
});

describe('ResendInboundProvider', () => {
  const body = JSON.stringify(event);

  it('verifies, parses the event, fetches the full email and normalizes it', async () => {
    const f = vi.fn(async (url: string) => new Response(JSON.stringify(received), { status: 200 }));
    const p = new ResendInboundProvider({ webhookSecret: secret, apiKey: 're_key', now, fetch: f as unknown as typeof fetch });
    const e = await p.receive({ body, headers: sign(body) });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails/receiving/56761188-7520-42d8-8898-ff6fc54ce618');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer re_key');

    expect(e.provider).toBe('resend');
    expect(e.providerId).toBe(event.data.email_id);
    expect(e.messageId).toBe('reply-1@mail.example.com');
    expect(e.references).toEqual(['quote-1@example.com']);
    expect(e.threadKey).toBe('quote-1@example.com');
    expect(e.from).toEqual({ name: 'Ana García', address: 'ana@example.com' });
    expect(e.replyTo).toEqual({ address: 'ana.reply@example.com' });
    expect(e.cc).toEqual([]);
    expect(e.replyText).toBe('Thanks, Friday works.');
    expect(e.html).toBe('<p>Thanks, Friday works.</p>');
    expect(e.headers['auto-submitted']).toEqual(['no']);
    expect(e.receivedAt.toISOString()).toBe('2026-10-23T15:00:00.000Z');
    expect(e.attachments).toEqual([{ filename: 'avatar.png', contentType: 'image/png', size: 1234, disposition: 'inline', contentId: 'avatar', providerRef: 'att_1' }]);
  });

  it('rejects bad signatures before fetching, and other event types', async () => {
    const f = vi.fn();
    const p = new ResendInboundProvider({ webhookSecret: secret, apiKey: 'k', now, fetch: f as unknown as typeof fetch });
    await expect(p.receive({ body, headers: { ...sign(body), 'svix-signature': 'v1,bad' } })).rejects.toMatchObject({ reason: 'bad-signature' });
    const other = JSON.stringify({ type: 'email.sent', data: {} });
    await expect(p.receive({ body: other, headers: sign(other) })).rejects.toMatchObject({ reason: 'unsupported-event' });
    await expect(p.receive({ body: 'nope', headers: sign('nope') })).rejects.toMatchObject({ reason: 'bad-payload' });
    expect(f).not.toHaveBeenCalled();
  });

  it('reports fetch failures and a missing api key', async () => {
    const p = new ResendInboundProvider({ apiKey: 'k', fetch: (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch });
    await expect(p.receive({ body, headers: {} })).rejects.toMatchObject({ reason: 'fetch-failed', status: 404 });
    await expect(new ResendInboundProvider().receive({ body, headers: {} })).rejects.toMatchObject({ reason: 'not-configured' });
  });

  it('accepts header arrays and fills gaps from the event', () => {
    const p = new ResendInboundProvider();
    const e = p.toInboundEmail(
      { ...received, headers: [{ name: 'Received', value: 'a' }, { name: 'Received', value: 'b' }], message_id: undefined, subject: undefined, reply_to: null },
      event as never,
    );
    expect(e.headers['received']).toEqual(['a', 'b']);
    expect(e.messageId).toBe('reply-1@mail.example.com');
    expect(e.subject).toBe('Re: Your quote');
    expect(e.replyTo).toBeUndefined();
  });

  it('lists attachment download urls', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ object: 'list', has_more: false, data: [{ ...received.attachments[0], download_url: 'https://dl/x', expires_at: '2026-10-23T16:00:00Z' }] })));
    const p = new ResendInboundProvider({ apiKey: 'k', fetch: f as unknown as typeof fetch });
    const list = await p.listAttachments('id1');
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe('https://api.resend.com/emails/receiving/id1/attachments');
    expect(list).toEqual([{ filename: 'avatar.png', contentType: 'image/png', size: 1234, disposition: 'inline', contentId: 'avatar', providerRef: 'att_1', downloadUrl: 'https://dl/x', expiresAt: '2026-10-23T16:00:00Z' }]);
  });
});

describe('FakeInboundProvider', () => {
  it('parses a posted fixture and records it', async () => {
    const p = new FakeInboundProvider();
    const e = await p.receive({ body: inboundFixtures.quotedPrintableSpanish, headers: {} });
    expect(e.provider).toBe('fake');
    expect(e.subject).toBe('Re: Cotización del jardín');
    expect(p.received).toHaveLength(1);
    p.reset();
    expect(p.received).toHaveLength(0);
  });
});
