import { createHash } from 'node:crypto';
import { normalizeEmail, type Mailbox } from './address.js';

/** Lower-cased header names; repeated headers (e.g. `received`) keep every value in order. */
export type InboundHeaders = Record<string, string[]>;

export interface InboundAttachment {
  filename: string;
  contentType: string;
  /** Decoded size in bytes when known. */
  size?: number;
  disposition?: 'attachment' | 'inline';
  /** `Content-ID` without brackets, for `cid:` references in the html. */
  contentId?: string;
  /** The provider's handle for fetching the bytes (e.g. Resend's attachment id). Bytes are never carried here. */
  providerRef?: string;
}

/** A received email, normalized across providers. */
export interface InboundEmail {
  provider: string;
  /** The provider's own id for this received email, when it has one. */
  providerId?: string;
  /** RFC 5322 Message-ID without the angle brackets. Synthesized (`generated-…`) when the mail had none. */
  messageId: string;
  /** See {@link threadKey}. */
  threadKey: string;
  inReplyTo?: string;
  /** Message-IDs from `References`, oldest first, without brackets. */
  references: string[];
  from: Mailbox;
  to: Mailbox[];
  cc: Mailbox[];
  /** Where a reply should go; falls back to `from`. */
  replyTo?: Mailbox;
  subject: string;
  text?: string;
  html?: string;
  /** The new content of the message: `text` (or text derived from `html`) with quoted history and signature removed. */
  replyText: string;
  attachments: InboundAttachment[];
  receivedAt: Date;
  headers: InboundHeaders;
}

/** First value of a header, case-insensitive. */
export function getHeader(source: InboundHeaders | Pick<InboundEmail, 'headers'>, name: string): string | undefined {
  const headers = 'headers' in source && !Array.isArray(source.headers) ? source.headers : (source as InboundHeaders);
  return headers[name.toLowerCase()]?.[0];
}

/** `<a@b> <c@d>` → `['a@b', 'c@d']`. */
export function parseMessageIds(value: string | undefined): string[] {
  if (!value) return [];
  const ids = value.match(/<[^<>\s]+>/g);
  if (ids) return ids.map((id) => id.slice(1, -1));
  return value.split(/\s+/).filter(Boolean);
}

const PREFIX_RE = /^\s*(?:(?:re|aw|sv|antw|fwd?|rv|tr|wg|enc)\s*(?:\[\d+\])?\s*:\s*)+/i;

/** Strips reply and forward prefixes in several languages (`Re:`, `RE[2]:`, `Fwd:`, `RV:`, `AW:`) and collapses whitespace. */
export function normalizeSubject(subject: string): string {
  return subject.replace(PREFIX_RE, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Stable key for "same subject, same people": lets a thread survive clients that drop `References`. */
export function subjectThreadKey(email: Pick<InboundEmail, 'subject' | 'from' | 'to' | 'cc'>): string {
  const people = [email.from, ...email.to, ...email.cc].map((m) => normalizeEmail(m.address));
  const h = createHash('sha256').update(JSON.stringify([normalizeSubject(email.subject), [...new Set(people)].sort()]));
  return `subject:${h.digest('hex').slice(0, 32)}`;
}

/**
 * The conversation a message belongs to:
 * 1. the root of `References` (or `In-Reply-To`) when the client threads properly;
 * 2. else the message's own `Message-ID`, so a thread's first message keys on the id its replies will reference;
 * 3. else (no Message-ID at all) the normalized subject plus participants.
 */
export function threadKey(email: Pick<InboundEmail, 'references' | 'inReplyTo' | 'subject' | 'from' | 'to' | 'cc'> & { messageId?: string }): string {
  const root = email.references[0] ?? email.inReplyTo;
  if (root) return root;
  if (email.messageId && !email.messageId.startsWith('generated-')) return email.messageId;
  return subjectThreadKey(email);
}

const QUOTE_INTRO = [
  /^On .{0,200}wrote:\s*$/,
  /^El .{0,200}escribi[oó]:\s*$/,
  /^Am .{0,200}schrieb .{0,100}:\s*$/,
  /^Le .{0,200}a écrit\s*:\s*$/,
  /^-{2,}\s*(Original Message|Mensaje original|Forwarded message|Mensaje reenviado)\s*-{2,}\s*$/i,
  /^_{10,}\s*$/,
];
// Outlook-style header block: "From: …" immediately followed by "Sent:/Date:/To:" (EN, ES, DE).
const OUTLOOK_FROM = /^(From|De|Von):\s.+$/;
const OUTLOOK_NEXT = /^(Sent|Date|To|Enviado|Fecha|Para|Gesendet|An):\s/;

/**
 * Keeps only the new text of a reply: drops everything from the first quote
 * introduction ("On … wrote:", "El … escribió:", "-----Original Message-----",
 * an Outlook `From:` block), `>`-quoted lines, and a `-- ` signature.
 */
export function stripQuotedReply(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === '-- ') break; // signature delimiter (the trailing space is the standard)
    const trimmed = line.trim();
    // "On <date>, <name>" may wrap onto the next line before "wrote:".
    const joined = i + 1 < lines.length ? `${trimmed} ${lines[i + 1]!.trim()}` : trimmed;
    if (QUOTE_INTRO.some((re) => re.test(trimmed) || re.test(joined))) break;
    if (OUTLOOK_FROM.test(trimmed) && OUTLOOK_NEXT.test(lines[i + 1]?.trim() ?? '')) break;
    if (trimmed.startsWith('>')) continue;
    kept.push(line);
  }
  return kept.join('\n').trim();
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Minimal html → text for `replyText`: drops `<blockquote>`, script and style, keeps line breaks. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, '')
    .replace(/<div class="gmail_quote[\s\S]*$/i, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, code: string) => {
      if (code[0] === '#') {
        const n = code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : m;
      }
      return ENTITIES[code.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface InboundInput {
  provider: string;
  providerId?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  from: Mailbox;
  to?: Mailbox[];
  cc?: Mailbox[];
  replyTo?: Mailbox;
  subject?: string;
  text?: string;
  html?: string;
  attachments?: InboundAttachment[];
  receivedAt?: Date;
  headers?: InboundHeaders;
}

/** Fills the derived fields (`messageId` fallback, `threadKey`, `replyText`) so every provider produces the same shape. */
export function createInboundEmail(input: InboundInput): InboundEmail {
  const headers = input.headers ?? {};
  const references = input.references ?? parseMessageIds(headers['references']?.[0]);
  const inReplyTo = input.inReplyTo ?? parseMessageIds(headers['in-reply-to']?.[0])[0];
  const to = input.to ?? [];
  const cc = input.cc ?? [];
  const subject = input.subject ?? '';
  const messageId =
    input.messageId ??
    parseMessageIds(headers['message-id']?.[0])[0] ??
    `generated-${createHash('sha256').update(JSON.stringify([input.from.address, subject, input.text ?? input.html ?? '', input.receivedAt?.toISOString() ?? ''])).digest('hex').slice(0, 24)}`;
  const base = { from: input.from, to, cc, subject, references, inReplyTo, messageId };
  const source = input.text ?? (input.html ? htmlToText(input.html) : '');
  return {
    provider: input.provider,
    providerId: input.providerId,
    messageId,
    threadKey: threadKey(base),
    inReplyTo,
    references,
    from: input.from,
    to,
    cc,
    replyTo: input.replyTo,
    subject,
    text: input.text,
    html: input.html,
    replyText: stripQuotedReply(source),
    attachments: input.attachments ?? [],
    receivedAt: input.receivedAt ?? new Date(),
    headers,
  };
}

/** What an inbound adapter receives from the transport: the raw body (unparsed, for signature checks) and its headers. */
export interface InboundRequest {
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface InboundProvider {
  readonly name: string;
  /** Verifies the request (signature, timestamp) and returns the normalized message. Throws {@link InboundError}. */
  receive(request: InboundRequest): Promise<InboundEmail>;
}

export type InboundErrorReason = 'bad-signature' | 'stale-timestamp' | 'bad-payload' | 'unsupported-event' | 'fetch-failed' | 'not-configured';

export class InboundError extends Error {
  constructor(
    readonly reason: InboundErrorReason,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'InboundError';
  }
}

/** Case-insensitive lookup in transport headers (`Record<string, string | string[]>`). */
export function requestHeader(headers: InboundRequest['headers'], name: string): string | undefined {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === want) return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}
