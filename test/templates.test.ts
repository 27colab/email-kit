import { describe, expect, it } from 'vitest';
import { createMailer, defineTemplate, escapeHtml, renderTemplate, resolveLocale, unsubscribeHeaders } from '../src/index.js';
import { FakeProvider } from '../src/testing.js';

const receipt = defineTemplate<{ name: string; total: number }>({
  id: 'receipt',
  defaultLocale: 'en',
  locales: {
    en: { subject: 'Your receipt', text: 'Hi {{name}}, total: ${{total}}', html: '<p>Hi {{name}}</p>{{{footer}}}' },
    es: { subject: (v) => `Tu recibo, ${v.name}`, text: 'Hola {{name}}, total: ${{total}}' },
  },
});

describe('templates', () => {
  it('renders each locale', () => {
    expect(renderTemplate(receipt, { name: 'Ana', total: 5 }, 'es')).toMatchObject({
      subject: 'Tu recibo, Ana',
      text: 'Hola Ana, total: $5',
      locale: 'es',
    });
  });

  it('falls back from region to language to default', () => {
    expect(resolveLocale(receipt as never, 'es-MX')).toBe('es');
    expect(resolveLocale(receipt as never, 'fr')).toBe('en');
    expect(resolveLocale(receipt as never)).toBe('en');
  });

  it('escapes html variables but not text, and allows triple-brace raw', () => {
    const r = renderTemplate(
      defineTemplate<{ name: string; footer: string }>({
        id: 'x',
        defaultLocale: 'en',
        locales: { en: { subject: 's', text: '{{name}}', html: '<b>{{name}}</b>{{{footer}}}' } },
      }),
      { name: '<script>', footer: '<i>ok</i>' },
    );
    expect(r.text).toBe('<script>');
    expect(r.html).toBe('<b>&lt;script&gt;</b><i>ok</i>');
    expect(escapeHtml(`"&'`)).toBe('&quot;&amp;&#39;');
  });

  it('throws on missing variables and bad default locale', () => {
    expect(() => renderTemplate(receipt, { name: 'A' } as never)).toThrow(/total/);
    expect(() => defineTemplate({ id: 'b', defaultLocale: 'en', locales: {} })).toThrow();
  });

  it('sendTemplate renders and sends', async () => {
    const p = new FakeProvider();
    const m = createMailer({ provider: p, from: 'a@example.com' });
    await m.sendTemplate(receipt, 'ana@example.com', { name: 'Ana', total: 5 }, {
      locale: 'es',
      message: { headers: unsubscribeHeaders({ httpsUrl: 'https://example.com/u/1' }) },
    });
    const sent = p.outbox[0]!.message;
    expect(sent.subject).toBe('Tu recibo, Ana');
    expect(sent.headers?.['List-Unsubscribe']).toBe('<https://example.com/u/1>');
    expect(sent.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });
});
