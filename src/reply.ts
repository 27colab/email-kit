import { formatMailbox, normalizeEmail, parseMailbox } from './address.js';
import { DEFAULT_HOP_HEADER } from './guards.js';
import { getHeader, type InboundEmail } from './inbound.js';
import type { Mailer, SendCallOptions } from './mailer.js';
import { escapeHtml } from './templates.js';
import type { EmailMessage, SendResult } from './types.js';

export type ReplyLocale = 'en' | 'es';

const REPLY_PREFIX = /^\s*(?:re|aw|sv|antw)\s*(?:\[\d+\])?\s*:/i;
const STACKED = /^\s*(?:(?:re|aw|sv|antw)\s*(?:\[\d+\])?\s*:\s*)+/i;

/** `Hola` → `Re: Hola`; `RE: Hola`, `Re[2]: Hola`, `Re: Re: Hola` → `Re: Hola`; `Fwd: x` → `Re: Fwd: x`; empty → `Re: (no subject)` / `(sin asunto)`. */
export function replySubject(subject: string, locale: ReplyLocale = 'en'): string {
  const base = subject.replace(/\s+/g, ' ').trim();
  if (!base) return `Re: ${locale === 'es' ? '(sin asunto)' : '(no subject)'}`;
  return REPLY_PREFIX.test(base) ? `Re: ${base.replace(STACKED, '').trim()}` : `Re: ${base}`;
}

export interface QuoteOptions {
  locale?: ReplyLocale;
  /** IANA time zone for the "On <date>" line. Default UTC. */
  timeZone?: string;
  /** Quote the stripped `replyText` (default) or the full `text`. */
  full?: boolean;
}

/** The trailing "On …, X wrote:" block, in text and html form. */
export function quoteOriginal(email: InboundEmail, opts: QuoteOptions = {}): { text: string; html: string } {
  const locale = opts.locale ?? 'en';
  const when = new Intl.DateTimeFormat(locale === 'es' ? 'es' : 'en', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: opts.timeZone ?? 'UTC',
  }).format(email.receivedAt);
  const who = formatMailbox(email.from);
  const intro = locale === 'es' ? `El ${when}, ${who} escribió:` : `On ${when}, ${who} wrote:`;
  const body = opts.full ? (email.text ?? email.replyText) : email.replyText;
  const text = `${intro}\n${body.split('\n').map((l) => `> ${l}`.trimEnd()).join('\n')}`;
  const html = `<div>${escapeHtml(intro)}</div><blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${
    email.html ?? escapeHtml(body).replace(/\n/g, '<br>')
  }</blockquote>`;
  return { text, html };
}

export interface ReplyOptions {
  text: string;
  html?: string;
  /** Sender; `"Name <addr>"` or bare address. Falls back to the mailer's default when sent through {@link sendReply}. */
  from?: string;
  /** Also cc the other original recipients (minus `from` and the reply target). Default false. */
  replyAll?: boolean;
  /** Append {@link quoteOriginal}. Default true. */
  quote?: boolean | QuoteOptions;
  locale?: ReplyLocale;
  /** Extra headers; `In-Reply-To`, `References` and the hop counter are always set. */
  headers?: Record<string, string>;
  /** Add `Auto-Submitted: auto-replied` (RFC 3834) so other systems do not answer back. Default false. */
  autoSubmitted?: boolean;
  hopHeader?: string;
}

/**
 * Builds the reply as an {@link EmailMessage}: threads with `In-Reply-To` and
 * `References`, prefixes the subject once, targets `Reply-To` (else `From`),
 * and bumps the hop counter that {@link isLoop} checks. Pure; send it with
 * {@link sendReply} or `mailer.send`.
 */
export function buildReply(email: InboundEmail, opts: ReplyOptions): EmailMessage {
  const locale = opts.locale ?? 'en';
  const target = email.replyTo ?? email.from;
  const hopHeader = opts.hopHeader ?? DEFAULT_HOP_HEADER;
  const hops = Number(getHeader(email, hopHeader) ?? '0');
  const headers: Record<string, string> = {
    ...opts.headers,
    'In-Reply-To': `<${email.messageId}>`,
    References: [...email.references, email.messageId].map((id) => `<${id}>`).join(' '),
    [hopHeader]: String((Number.isFinite(hops) ? hops : 0) + 1),
  };
  if (opts.autoSubmitted) headers['Auto-Submitted'] = 'auto-replied';

  let text = opts.text;
  let html = opts.html;
  if (opts.quote !== false) {
    const q = quoteOriginal(email, { locale, ...(typeof opts.quote === 'object' ? opts.quote : {}) });
    text = `${text.trimEnd()}\n\n${q.text}`;
    if (html !== undefined) html = `${html}<br><br>${q.html}`;
  }

  const message: EmailMessage = { to: target.address, subject: replySubject(email.subject, locale), text, headers };
  if (html !== undefined) message.html = html;
  if (opts.from) message.from = opts.from;
  if (opts.replyAll) {
    const skip = new Set([target.address, email.from.address, opts.from ? parseMailbox(opts.from)?.address : undefined].filter(Boolean).map((a) => normalizeEmail(a!)));
    const cc = [...email.to, ...email.cc].map((m) => normalizeEmail(m.address)).filter((a) => !skip.has(a));
    if (cc.length) message.cc = [...new Set(cc)];
  }
  return message;
}

/**
 * {@link buildReply} + `mailer.send`, so validation, suppression, idempotency and
 * retry apply. The idempotency scope is the inbound `messageId`, so the same
 * reply to the same message is sent once, while identical replies to different
 * messages are not mistaken for duplicates.
 */
export async function sendReply(mailer: Mailer, email: InboundEmail, opts: ReplyOptions & { send?: SendCallOptions }): Promise<SendResult> {
  const { send, ...reply } = opts;
  return mailer.send(buildReply(email, reply), { idempotencyScope: `reply:${email.messageId}`, ...send });
}
