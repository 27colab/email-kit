import { createHash } from 'node:crypto';
import { isValidEmail, normalizeEmail } from './address.js';
import type { Mailer } from './mailer.js';
import type { SendResult } from './types.js';

const SPOKEN: Record<string, Record<string, string>> = {
  en: { at: '@', dot: '.', underscore: '_', dash: '-', hyphen: '-', plus: '+' },
  es: { arroba: '@', punto: '.', guion: '-', 'guion bajo': '_', 'guión': '-', 'guión bajo': '_', mas: '+', 'más': '+' },
};

/**
 * Turn dictated speech ("jane dot doe at example dot com") or loosely typed text
 * into an address. Returns undefined when the result is not a valid address, so
 * callers should re-prompt rather than send.
 */
export function parseSpokenEmail(input: string, locales: string[] = ['en', 'es']): string | undefined {
  const table: Record<string, string> = Object.assign({}, ...locales.map((l) => SPOKEN[l] ?? {}));
  let s = input.trim().toLowerCase();
  // longest phrases first so "guion bajo" wins over "guion"
  for (const phrase of Object.keys(table).sort((a, b) => b.length - a.length)) {
    s = s.replace(new RegExp(`(^|\\s)${phrase}(?=\\s|$)`, 'g'), `$1${table[phrase]}`);
  }
  s = s.replace(/\s+/g, '').replace(/[.,;!?]+$/, '');
  return isValidEmail(s) ? normalizeEmail(s) : undefined;
}

/** "jane.doe@example.com" -> "j a n e dot d o e at e x a m p l e dot c o m" for read-back confirmation. */
export function spellOut(address: string, locale: 'en' | 'es' = 'en'): string {
  const words = locale === 'es' ? { '@': 'arroba', '.': 'punto', _: 'guion bajo', '-': 'guion', '+': 'más' } : { '@': 'at', '.': 'dot', _: 'underscore', '-': 'dash', '+': 'plus' };
  return [...address].map((c) => (words as Record<string, string>)[c] ?? c).join(' ');
}

export interface EmailMeThisRequest {
  /** Address the user gave for themselves. */
  address: string;
  /** Set only after the user confirmed the read-back. */
  confirmed: boolean;
  subject: string;
  text: string;
  html?: string;
  /** Identifies the conversation/turn so a repeated tool call cannot send twice. */
  requestId: string;
}

export type EmailMeThisOutcome =
  | { status: 'sent'; result: SendResult }
  | { status: 'needs-confirmation'; readBack: string }
  | { status: 'invalid-address' }
  | { status: 'suppressed' };

/**
 * "Email me this" flow for chat/voice bots. Sends only to the address the user gave
 * for themselves, only after confirmation, and at most once per requestId.
 */
export function createEmailMeThis(mailer: Mailer, opts: { locale?: 'en' | 'es' } = {}) {
  return async function emailMeThis(req: EmailMeThisRequest): Promise<EmailMeThisOutcome> {
    const address = parseSpokenEmail(req.address) ?? (isValidEmail(req.address) ? normalizeEmail(req.address) : undefined);
    if (!address) return { status: 'invalid-address' };
    if (!req.confirmed) return { status: 'needs-confirmation', readBack: spellOut(address, opts.locale) };
    try {
      const result = await mailer.send(
        { to: address, subject: req.subject, text: req.text, html: req.html },
        { idempotencyKey: `emt_${createHash('sha256').update(`${req.requestId}|${address}`).digest('hex').slice(0, 32)}` },
      );
      return { status: 'sent', result };
    } catch (e) {
      if ((e as { reason?: string }).reason === 'suppressed') return { status: 'suppressed' };
      throw e;
    }
  };
}
