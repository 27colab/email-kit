import { describe, expect, it } from 'vitest';
import { MemorySuppressionList, autoResponderReason, inspectInbound, isAutoResponder, isLoop, loopReason } from '../src/index.js';
import { fakeInbound, inboundFixture } from '../src/testing.js';

describe('autoResponderReason', () => {
  it('detects the fixture out-of-office and headers individually', () => {
    expect(autoResponderReason(inboundFixture('autoResponder'))).toBe('auto-submitted');
    expect(autoResponderReason(fakeInbound({ headers: { 'auto-submitted': ['no'] } }))).toBeUndefined();
    expect(autoResponderReason(fakeInbound({ headers: { precedence: ['Bulk'] } }))).toBe('precedence');
    expect(autoResponderReason(fakeInbound({ headers: { 'x-autoreply': ['yes'] } }))).toBe('x-autoreply');
    expect(autoResponderReason(fakeInbound({ headers: { 'list-id': ['<news.example.com>'] } }))).toBe('list');
    expect(autoResponderReason(fakeInbound({ headers: { 'return-path': ['<>'] } }))).toBe('null-return-path');
    expect(autoResponderReason(fakeInbound({ from: { address: 'MAILER-DAEMON@example.com' } }))).toBe('daemon-sender');
  });

  it.each([
    'Automatic reply: Floor plans',
    'Out of Office',
    'Re: Respuesta automática: Hola',
    'Fuera de la oficina',
    'Undeliverable: Hola',
    'Delivery Status Notification (Failure)',
  ])('flags subject %s', (subject) => expect(autoResponderReason(fakeInbound({ subject }))).toBe('subject'));

  it('leaves human mail alone', () => {
    expect(isAutoResponder(inboundFixture('plain'))).toBe(false);
    expect(isAutoResponder(fakeInbound({ subject: 'Reply about the office' }))).toBe(false);
  });
});

describe('loopReason', () => {
  const ours = ['ours-1@example.com', 'ours-2@example.com'];

  it('flags the loop fixture by hop limit, and by own sender when configured', () => {
    expect(loopReason(inboundFixture('loop'))).toBe('hop-limit');
    expect(loopReason(inboundFixture('loop'), { ourAddresses: ['HELLO@example.com'] })).toBe('own-sender');
    expect(loopReason(inboundFixture('loop'), { hopLimit: 6 })).toBeUndefined();
  });

  it('flags our own message id, with a set or a predicate', () => {
    expect(loopReason(fakeInbound({ messageId: 'ours-1@example.com' }), { ourMessageIds: ours })).toBe('own-message-id');
    expect(loopReason(fakeInbound({ messageId: 'ours-9@example.com' }), { ourMessageIds: (id) => id.startsWith('ours-') })).toBe('own-message-id');
  });

  it('does not flag a human reply that references our message', () => {
    expect(isLoop(fakeInbound({ references: ['ours-1@example.com'] }), { ourMessageIds: ours })).toBe(false);
    expect(loopReason(fakeInbound({ references: [...ours, 'x@y'] }), { ourMessageIds: ours, maxOwnReferences: 2 })).toBe('own-references');
  });

  it('flags a sender burst within the window', () => {
    const at = new Date('2026-10-23T15:00:00Z');
    const recent = [1, 2, 30].map((s) => new Date(at.getTime() - s * 1000));
    expect(loopReason(fakeInbound({ receivedAt: at }), { recentFromSender: recent })).toBe('sender-rate');
    expect(loopReason(fakeInbound({ receivedAt: at }), { recentFromSender: recent, windowMs: 10_000 })).toBeUndefined();
    expect(loopReason(fakeInbound({ receivedAt: at }), { recentFromSender: recent, maxPerWindow: 4 })).toBeUndefined();
  });
});

describe('inspectInbound', () => {
  it('flags a suppressed sender without dropping the message', async () => {
    const suppression = new MemorySuppressionList();
    suppression.add('ana@example.com', 'unsubscribed');
    const flags = await inspectInbound(fakeInbound(), { suppression });
    expect(flags).toEqual({ autoResponder: undefined, loop: undefined, suppressedSender: true, flagged: true });
    expect(await inspectInbound(fakeInbound({ from: { address: 'ok@example.com' } }), { suppression })).toMatchObject({ suppressedSender: false, flagged: false });
  });

  it('combines guards', async () => {
    const flags = await inspectInbound(inboundFixture('autoResponder'), { loop: { ourAddresses: ['bob@example.com'] } });
    expect(flags).toMatchObject({ autoResponder: 'auto-submitted', loop: 'own-sender', suppressedSender: false, flagged: true });
  });
});
