import { describe, expect, it } from 'vitest';
import { createInboundEmail, htmlToText, normalizeSubject, stripQuotedReply, subjectThreadKey, threadKey } from '../src/index.js';
import { fakeInbound } from '../src/testing.js';

describe('threading', () => {
  it('normalizes subjects across languages and stacking', () => {
    expect(normalizeSubject('Re: RE: Fwd: RV:  Hola  mundo ')).toBe('hola mundo');
    expect(normalizeSubject('Re[2]: Hola')).toBe('hola');
    expect(normalizeSubject('Hola')).toBe('hola');
  });

  it('keys on the References root, then own id, then subject + participants', () => {
    const base = { from: { address: 'a@x.com' }, to: [{ address: 'b@x.com' }], cc: [], subject: 'Hi' };
    expect(threadKey({ ...base, references: ['root@x', 'mid@x'], inReplyTo: 'mid@x', messageId: 'm@x' })).toBe('root@x');
    expect(threadKey({ ...base, references: [], inReplyTo: 'mid@x', messageId: 'm@x' })).toBe('mid@x');
    expect(threadKey({ ...base, references: [], messageId: 'm@x' })).toBe('m@x');
    const fallback = threadKey({ ...base, references: [], messageId: 'generated-abc' });
    expect(fallback).toBe(subjectThreadKey(base));
    // participants order and case do not matter
    expect(subjectThreadKey({ ...base, from: { address: 'B@x.com' }, to: [{ address: 'a@x.com' }], subject: 'Re: hi' })).toBe(fallback);
    expect(subjectThreadKey({ ...base, to: [{ address: 'c@x.com' }] })).not.toBe(fallback);
  });

  it('createInboundEmail derives ids from headers when not given', () => {
    const e = createInboundEmail({
      provider: 'x',
      from: { address: 'a@x.com' },
      headers: { 'message-id': ['<m1@x>'], references: ['<r0@x> <r1@x>'], 'in-reply-to': ['<r1@x>'] },
      html: '<p>Yes<br>please</p><blockquote>old</blockquote>',
    });
    expect(e.messageId).toBe('m1@x');
    expect(e.references).toEqual(['r0@x', 'r1@x']);
    expect(e.inReplyTo).toBe('r1@x');
    expect(e.threadKey).toBe('r0@x');
    expect(e.replyText).toBe('Yes\nplease');
    expect(e.text).toBeUndefined();
  });
});

describe('stripQuotedReply', () => {
  it.each([
    ['Gmail EN', 'Yes.\n\nOn Thu, 22 Oct 2026 at 18:02, Acme <hello@x.com> wrote:\n> q', 'Yes.'],
    ['Gmail EN wrapped', 'Yes.\n\nOn Thu, 22 Oct 2026 at 18:02, Acme\n<hello@x.com> wrote:\n> q', 'Yes.'],
    ['Gmail ES', 'Sí.\n\nEl jue, 22 oct 2026 a las 18:02, Acme <hello@x.com> escribió:\n> q', 'Sí.'],
    ['Outlook', 'Sure\n\n-----Original Message-----\nFrom: x\nSent: y', 'Sure'],
    ['Outlook ES', 'Claro\n\nDe: Acme <hello@x.com>\nEnviado: jueves\n', 'Claro'],
    ['Outlook rule', 'Claro\n\n________________________________\nFrom: Acme', 'Claro'],
    ['human From: sentence kept', 'From: my side it is fine.\nThanks', 'From: my side it is fine.\nThanks'],
    ['quote lines only', 'top\n> a\n> b\nbottom', 'top\nbottom'],
    ['signature', 'Hi\n-- \nJane\nCEO', 'Hi'],
    ['crlf', 'Hi\r\n\r\nOn x wrote:\r\n> y', 'Hi'],
  ])('%s', (_name, input, out) => expect(stripQuotedReply(input)).toBe(out));

  it('keeps text with no quote', () => {
    expect(stripQuotedReply('Just this\nand that\n')).toBe('Just this\nand that');
  });
});

describe('htmlToText', () => {
  it('drops quotes, scripts and tags; decodes entities', () => {
    expect(htmlToText('<style>p{}</style><div>Hi &amp; bye&nbsp;&#8212;&#x41;</div><div class="gmail_quote">old</div>')).toBe('Hi & bye —A');
  });
});

describe('fakeInbound', () => {
  it('builds a complete message with overrides', () => {
    const e = fakeInbound({ subject: 'X', references: ['r@x'] });
    expect(e.subject).toBe('X');
    expect(e.threadKey).toBe('r@x');
    expect(e.replyText).toBe('Hola, ¿tienen disponibilidad el viernes?');
  });
});
