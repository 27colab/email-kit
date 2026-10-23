import { describe, expect, it } from 'vitest';
import { MemorySuppressionList, buildReply, createMailer, isLoop, quoteOriginal, replySubject, sendReply } from '../src/index.js';
import { FakeProvider, fakeInbound, inboundFixture } from '../src/testing.js';

describe('replySubject', () => {
  it.each([
    ['Hola', 'Re: Hola'],
    ['Re: Hola', 'Re: Hola'],
    ['RE: Hola', 'Re: Hola'],
    ['Re: Re: RE: Hola', 'Re: Hola'],
    ['Re[2]: Hola', 'Re: Hola'],
    ['AW: Hola', 'Re: Hola'],
    ['Fwd: Hola', 'Re: Fwd: Hola'],
    ['RV: Hola', 'Re: RV: Hola'],
    ['  spaced   out ', 'Re: spaced out'],
  ])('%s → %s', (input, out) => expect(replySubject(input)).toBe(out));

  it('handles empty subjects per locale', () => {
    expect(replySubject('')).toBe('Re: (no subject)');
    expect(replySubject('  ', 'es')).toBe('Re: (sin asunto)');
  });
});

describe('quoteOriginal', () => {
  it('quotes the stripped reply text with an EN or ES intro', () => {
    const e = inboundFixture('plain');
    const en = quoteOriginal(e);
    expect(en.text).toBe('On Oct 23, 2026, 3:00 PM, Ana García <ana@example.com> wrote:\n> Thanks, Friday at 10 works for me.');
    expect(en.html).toContain('<blockquote');
    expect(en.html).toContain('Thanks, Friday at 10 works for me.');
    const es = quoteOriginal(e, { locale: 'es', timeZone: 'America/Mexico_City' });
    expect(es.text).toMatch(/^El 23 oct 2026, 9:00.*Ana García <ana@example.com> escribió:\n> Thanks/);
  });

  it('can quote the full text and uses the original html when present', () => {
    const e = inboundFixture('multipart');
    const q = quoteOriginal(e, { full: true });
    expect(q.html).toContain('<p>Plans <b>attached</b>.');
    expect(quoteOriginal(fakeInbound({ text: 'a\n\n> old', html: undefined })).text.endsWith('> a')).toBe(true);
  });
});

describe('buildReply', () => {
  const e = inboundFixture('plain');

  it('threads, prefixes once, targets the sender and bumps the hop counter', () => {
    const m = buildReply(e, { text: 'See you Friday.', quote: false });
    expect(m).toEqual({
      to: 'ana@example.com',
      subject: 'Re: Your quote',
      text: 'See you Friday.',
      headers: {
        'In-Reply-To': '<reply-1@mail.example.com>',
        References: '<quote-1@example.com> <reply-1@mail.example.com>',
        'X-Email-Kit-Hops': '1',
      },
    });
  });

  it('appends the quote by default, to text and html', () => {
    const m = buildReply(e, { text: 'Great.', html: '<p>Great.</p>' });
    expect(m.text).toBe('Great.\n\nOn Oct 23, 2026, 3:00 PM, Ana García <ana@example.com> wrote:\n> Thanks, Friday at 10 works for me.');
    expect(m.html).toMatch(/^<p>Great\.<\/p><br><br><div>On .* wrote:<\/div><blockquote/);
  });

  it('uses Reply-To and ccs the other participants on replyAll', () => {
    const m = buildReply(inboundFixture('multipart'), { text: 'Looks good', from: 'Acme <hello@example.com>', replyAll: true, quote: false });
    expect(m.to).toBe('jane.doe@example.org');
    expect(m.cc).toEqual(['bob@example.com', 'carla@example.com']);
    expect(m.from).toBe('Acme <hello@example.com>');
    expect(buildReply(inboundFixture('multipart'), { text: 'x', quote: false }).cc).toBeUndefined();
  });

  it('increments an existing hop counter and can mark itself auto-submitted', () => {
    const m = buildReply(inboundFixture('loop'), { text: 'x', quote: false, autoSubmitted: true, headers: { 'X-Custom': '1' } });
    expect(m.headers).toMatchObject({ 'X-Email-Kit-Hops': '6', 'Auto-Submitted': 'auto-replied', 'X-Custom': '1' });
    expect(m.subject).toBe('Re: Hola');
  });

  it('a reply received back is caught by the hop limit', () => {
    let current = fakeInbound();
    for (let hop = 0; hop < 5; hop++) {
      const m = buildReply(current, { text: 'again', quote: false });
      expect(isLoop(current)).toBe(hop >= 5);
      current = fakeInbound({ messageId: `m-${hop}@x`, headers: { 'x-email-kit-hops': [m.headers!['X-Email-Kit-Hops']!] } });
    }
    expect(isLoop(current)).toBe(true);
  });
});

describe('sendReply', () => {
  it('goes through the mailer: idempotent per inbound message, suppression applies', async () => {
    const provider = new FakeProvider();
    const suppression = new MemorySuppressionList();
    const mailer = createMailer({ provider, from: 'Acme <hello@example.com>', suppression });
    const e = inboundFixture('plain');

    const a = await sendReply(mailer, e, { text: 'See you Friday.' });
    const b = await sendReply(mailer, e, { text: 'See you Friday.' });
    expect(b).toEqual(a);
    expect(provider.outbox).toHaveLength(1);
    expect(provider.outbox[0]!.message.headers?.['In-Reply-To']).toBe('<reply-1@mail.example.com>');
    expect(provider.outbox[0]!.message.from).toBe('Acme <hello@example.com>');

    // same text to a different inbound message is a different send
    await sendReply(mailer, fakeInbound({ messageId: 'other@x', from: e.from, subject: 'Your quote' }), { text: 'See you Friday.', quote: false });
    expect(provider.outbox).toHaveLength(2);

    suppression.add('ana@example.com', 'unsubscribed');
    await expect(sendReply(mailer, fakeInbound({ messageId: 'third@x' }), { text: 'hi' })).rejects.toMatchObject({ reason: 'suppressed' });
  });

  it('validates cc addresses and forwards them to the provider', async () => {
    const provider = new FakeProvider();
    const mailer = createMailer({ provider, from: 'hello@example.com' });
    await expect(mailer.send({ to: 'a@example.com', cc: ['nope'], subject: 's', text: 't' })).rejects.toMatchObject({ reason: 'invalid-address' });
    await mailer.send({ to: 'a@example.com', cc: ['b@example.com'], subject: 's', text: 't' });
    expect(provider.outbox[0]!.message.cc).toEqual(['b@example.com']);
  });
});
