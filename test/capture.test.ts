import { describe, expect, it } from 'vitest';
import { MemorySuppressionList, createEmailMeThis, createMailer, parseSpokenEmail, spellOut } from '../src/index.js';
import { FakeProvider } from '../src/testing.js';

describe('parseSpokenEmail', () => {
  it.each([
    ['jane dot doe at example dot com', 'jane.doe@example.com'],
    ['Jane.Doe@Example.com', 'jane.doe@example.com'],
    ['juan guion perez arroba ejemplo punto com', 'juan-perez@ejemplo.com'],
    ['a plus tag at example dot org.', 'a+tag@example.org'],
  ])('%s', (input, out) => expect(parseSpokenEmail(input)).toBe(out));

  it('rejects incomplete addresses', () => {
    expect(parseSpokenEmail('jane at example')).toBeUndefined();
    expect(parseSpokenEmail('hello')).toBeUndefined();
  });

  it('spells out for read-back', () => {
    expect(spellOut('a.b@ex.com')).toBe('a dot b at e x dot c o m');
    expect(spellOut('a@ex.com', 'es')).toBe('a arroba e x punto c o m');
  });
});

describe('emailMeThis', () => {
  const setup = () => {
    const provider = new FakeProvider();
    const suppression = new MemorySuppressionList();
    const run = createEmailMeThis(createMailer({ provider, from: 'bot@example.com', suppression }));
    return { provider, suppression, run };
  };
  const base = { subject: 'Notes', text: 'Here you go', requestId: 'turn-1' };

  it('asks for confirmation first, then sends once', async () => {
    const { provider, run } = setup();
    const first = await run({ ...base, address: 'jane dot doe at example dot com', confirmed: false });
    expect(first).toEqual({ status: 'needs-confirmation', readBack: 'j a n e dot d o e at e x a m p l e dot c o m' });
    expect(provider.calls).toBe(0);

    const sent = await run({ ...base, address: 'jane.doe@example.com', confirmed: true });
    expect(sent.status).toBe('sent');
    await run({ ...base, address: 'jane.doe@example.com', confirmed: true }); // model repeats the tool call
    expect(provider.outbox).toHaveLength(1);
  });

  it('rejects invalid and reports suppressed', async () => {
    const { suppression, run } = setup();
    expect(await run({ ...base, address: 'nope', confirmed: true })).toEqual({ status: 'invalid-address' });
    suppression.add('jane.doe@example.com', 'unsubscribed');
    expect(await run({ ...base, address: 'jane.doe@example.com', confirmed: true })).toEqual({ status: 'suppressed' });
  });
});
