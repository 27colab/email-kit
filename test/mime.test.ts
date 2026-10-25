import { describe, expect, it } from 'vitest';
import { decodeEncodedWords, decodeQuotedPrintable, inboundFromMime, parseHeaderValue, parseMailboxList, parseMime } from '../src/index.js';
import { inboundFixtures } from '../src/testing.js';

describe('parseMime', () => {
  it('parses a plain message with threading headers', () => {
    const e = inboundFromMime(inboundFixtures.plain);
    expect(e.from).toEqual({ name: 'Ana García', address: 'ana@example.com' });
    expect(e.to).toEqual([{ name: 'Acme', address: 'hello@example.com' }]);
    expect(e.messageId).toBe('reply-1@mail.example.com');
    expect(e.inReplyTo).toBe('quote-1@example.com');
    expect(e.references).toEqual(['quote-1@example.com']);
    expect(e.threadKey).toBe('quote-1@example.com');
    expect(e.text).toContain('> Here is the quote');
    expect(e.replyText).toBe('Thanks, Friday at 10 works for me.');
    expect(e.receivedAt.toISOString()).toBe('2026-10-23T15:00:00.000Z');
    expect(e.attachments).toEqual([]);
    expect(e.provider).toBe('mime');
  });

  it('walks nested multipart, picks text and html, lists attachments as metadata', () => {
    const e = inboundFromMime(inboundFixtures.multipart);
    expect(e.from).toEqual({ name: 'Doe, Jane', address: 'jane@example.com' });
    expect(e.to.map((m) => m.address)).toEqual(['hello@example.com', 'bob@example.com']);
    expect(e.cc).toEqual([{ address: 'carla@example.com' }]);
    expect(e.replyTo).toEqual({ address: 'jane.doe@example.org' });
    expect(e.text).toBe('Plans attached. Let me know what you think.');
    expect(e.html).toBe('<p>Plans <b>attached</b>. Let me know what you think.</p><img src="cid:logo1">');
    expect(e.attachments).toEqual([
      { filename: 'plans.pdf', contentType: 'application/pdf', size: 52, disposition: 'attachment' },
      { filename: 'logo.png', contentType: 'image/png', size: 70, disposition: 'inline', contentId: 'logo1' },
    ]);
    expect(e.threadKey).toBe('plans-1@example.com');
  });

  it('decodes quoted-printable bodies and RFC 2047 headers (Spanish accents)', () => {
    const e = inboundFromMime(inboundFixtures.quotedPrintableSpanish);
    expect(e.from).toEqual({ name: 'José Muñoz', address: 'jose@example.com' });
    expect(e.subject).toBe('Re: Cotización del jardín');
    expect(e.text).toContain('Buenos días, ¿podrían venir el miércoles por la mañana?');
    expect(e.replyText).toBe('Buenos días, ¿podrían venir el miércoles por la mañana?\n\nGracias,\nJosé');
  });

  it('decodes base64 text parts with a non-utf8 charset', () => {
    const raw = `Content-Type: text/plain; charset="iso-8859-1"\nContent-Transfer-Encoding: base64\nFrom: a@example.com\n\n${Buffer.from('Ma\xf1ana', 'latin1').toString('base64')}\n`;
    expect(parseMime(raw).text).toBe('Mañana');
  });

  it('accepts bytes and 8bit utf-8 text', () => {
    const raw = Buffer.from('From: a@example.com\nSubject: Café\nContent-Type: text/plain; charset=utf-8\n\n¡Hola!\n', 'utf8');
    const e = inboundFromMime(raw);
    expect(e.subject).toBe('Café');
    expect(e.text).toBe('¡Hola!');
  });

  it('synthesizes a message id and falls back to subject threading when none exists', () => {
    const e = inboundFromMime('From: a@example.com\nTo: b@example.com\nSubject: RE: Hello\n\nhi\n');
    expect(e.messageId).toMatch(/^generated-[0-9a-f]{24}$/);
    expect(e.threadKey).toMatch(/^subject:[0-9a-f]{32}$/);
    const same = inboundFromMime('From: a@example.com\nTo: b@example.com\nSubject: Re: hello\n\nhi again\n');
    expect(same.threadKey).toBe(e.threadKey);
  });

  it('does not choke on a body without headers or a truncated multipart', () => {
    expect(parseMime('just text').text).toBe('just text');
    const t = parseMime('Content-Type: multipart/mixed; boundary=x\n\n--x\nContent-Type: text/plain\n\nhello');
    expect(t.text).toBe('hello');
  });
});

describe('header helpers', () => {
  it('parses params, quoted values and RFC 2231 continuations', () => {
    expect(parseHeaderValue('text/plain; charset="UTF-8"; format=flowed')).toEqual({ value: 'text/plain', params: { charset: 'UTF-8', format: 'flowed' } });
    expect(parseHeaderValue("attachment; filename*=utf-8''ni%C3%B1o.pdf").params['filename']).toBe('niño.pdf');
    expect(parseHeaderValue("attachment; filename*0*=utf-8''ni%C3%B1; filename*1*=o.pdf").params['filename']).toBe('niño.pdf');
  });

  it('decodes encoded words, joining adjacent ones', () => {
    expect(decodeEncodedWords('=?UTF-8?Q?Hola_Mar=C3=ADa?= =?UTF-8?Q?_y_Jos=C3=A9?=')).toBe('Hola María y José');
    expect(decodeEncodedWords('=?ISO-8859-1?B?TWHxYW5h?=')).toBe('Mañana');
    expect(decodeEncodedWords('plain')).toBe('plain');
  });

  it('decodes quoted-printable soft breaks', () => {
    expect(decodeQuotedPrintable('a=\r\nb=3D')).toBe('ab=');
  });

  it('parses mailbox lists with quoted commas', () => {
    expect(parseMailboxList('"Doe, Jane" <J@Example.com>, bob@example.com, <c@example.com>')).toEqual([
      { name: 'Doe, Jane', address: 'j@example.com' },
      { address: 'bob@example.com' },
      { address: 'c@example.com' },
    ]);
    expect(parseMailboxList(undefined)).toEqual([]);
  });
});
