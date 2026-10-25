import { parseMailbox, parseMailboxList } from './address.js';
import { createInboundEmail, parseMessageIds, type InboundAttachment, type InboundEmail, type InboundHeaders } from './inbound.js';

/** Parsed `Content-Type` / `Content-Disposition`: `value` lower-cased, params lower-cased keys. */
export interface HeaderValue {
  value: string;
  params: Record<string, string>;
}

export interface MimePart {
  headers: InboundHeaders;
  contentType: HeaderValue;
  /** Decoded text for `text/*` leaf parts. */
  text?: string;
  /** Decoded byte length of the body (leaf parts only). */
  size: number;
  parts: MimePart[];
}

export interface ParsedMime {
  headers: InboundHeaders;
  text?: string;
  html?: string;
  attachments: InboundAttachment[];
  root: MimePart;
}

/** Bytes as a 1:1 "binary" string so boundaries can be searched without touching the encoding. */
function toBinaryString(raw: string | Uint8Array): string {
  const bytes = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw;
  return Buffer.from(bytes).toString('latin1');
}

export function parseHeaderValue(input: string | undefined, fallback = ''): HeaderValue {
  const params: Record<string, string> = {};
  if (!input) return { value: fallback, params };
  const [first, ...rest] = input.split(';');
  const continued: Record<string, { encoded: boolean; chunks: string[] }> = {};
  for (const p of rest) {
    const m = /^\s*([^=\s]+?)(\*(\d+))?(\*)?\s*=\s*(.*?)\s*$/s.exec(p);
    if (!m) continue;
    const name = m[1]!.toLowerCase();
    const value = m[5]!.replace(/^"(.*)"$/s, '$1');
    if (m[2] || m[4]) {
      // RFC 2231: name*=charset''value or name*0*=..., name*1*=...
      const slot = (continued[name] ??= { encoded: false, chunks: [] });
      slot.chunks[m[3] ? Number(m[3]) : 0] = value;
      if (m[4]) slot.encoded = true;
    } else params[name] = decodeEncodedWords(value);
  }
  for (const [name, { encoded, chunks }] of Object.entries(continued)) {
    const joined = chunks.join('');
    if (!encoded) params[name] = joined;
    else {
      const [charset, , data] = joined.split("'");
      const bytes = Buffer.from((data ?? joined).replace(/%([0-9a-f]{2})/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1');
      params[name] = decodeCharset(bytes, charset || 'utf-8');
    }
  }
  return { value: first!.trim().toLowerCase() || fallback, params };
}

export function decodeQuotedPrintable(input: string): string {
  return input.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
}

export function decodeCharset(bytes: Uint8Array, charset: string): string {
  const label = charset.trim().toLowerCase().replace(/^"|"$/g, '') || 'utf-8';
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** Decodes the body of a part to bytes according to `Content-Transfer-Encoding`. */
export function decodeTransfer(body: string, encoding: string | undefined): Uint8Array {
  switch ((encoding ?? '7bit').trim().toLowerCase()) {
    case 'base64':
      return Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
    case 'quoted-printable':
      return Buffer.from(decodeQuotedPrintable(body), 'latin1');
    default:
      return Buffer.from(body, 'latin1');
  }
}

/** RFC 2047 `=?utf-8?Q?Hola_Mar=C3=ADa?=` and `=?UTF-8?B?...?=` inside header values. */
export function decodeEncodedWords(value: string): string {
  return value
    .replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/g, '$1')
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_m, charset: string, enc: string, data: string) => {
      const bytes =
        enc.toLowerCase() === 'b'
          ? Buffer.from(data, 'base64')
          : Buffer.from(decodeQuotedPrintable(data.replace(/_/g, ' ')), 'latin1');
      return decodeCharset(bytes, charset);
    });
}

/** Splits a raw message (binary string) into headers and body; headers unfolded, names lower-cased, encoded words decoded. */
function splitHeaders(raw: string): { headers: InboundHeaders; body: string } {
  const headers: InboundHeaders = {};
  const m = /\r?\n\r?\n/.exec(raw);
  const head = m ? raw.slice(0, m.index) : raw;
  const body = m ? raw.slice(m.index + m[0].length) : '';
  if (!/^[\w-]+\s*:/.test(head)) return { headers, body: raw };
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    const value = decodeEncodedWords(Buffer.from(line.slice(idx + 1).trim(), 'latin1').toString('utf8'));
    (headers[name] ??= []).push(value);
  }
  return { headers, body };
}

function parsePart(raw: string, depth: number): MimePart {
  const { headers, body } = splitHeaders(raw);
  const contentType = parseHeaderValue(headers['content-type']?.[0], 'text/plain');
  const part: MimePart = { headers, contentType, size: 0, parts: [] };
  const boundary = contentType.params['boundary'];
  if (contentType.value.startsWith('multipart/') && boundary && depth < 20) {
    const marker = `--${boundary}`;
    const lines = body.split(/\r?\n/);
    let current: string[] | undefined;
    for (const line of lines) {
      if (line === marker || line === `${marker}--`) {
        if (current) part.parts.push(parsePart(current.join('\n'), depth + 1));
        current = line === marker ? [] : undefined;
        if (!current) break;
      } else if (current) current.push(line);
    }
    if (current) part.parts.push(parsePart(current.join('\n'), depth + 1)); // no closing boundary
    return part;
  }
  const bytes = decodeTransfer(body, headers['content-transfer-encoding']?.[0]);
  part.size = bytes.byteLength;
  if (contentType.value.startsWith('text/')) part.text = decodeCharset(bytes, contentType.params['charset'] ?? 'utf-8');
  return part;
}

function collect(part: MimePart, out: ParsedMime): void {
  if (part.contentType.value.startsWith('multipart/')) {
    // First text/plain and first text/html win; covers multipart/alternative, mixed and related.
    for (const p of part.parts) collect(p, out);
    return;
  }
  const disposition = parseHeaderValue(part.headers['content-disposition']?.[0]);
  const filename = disposition.params['filename'] ?? part.contentType.params['name'];
  const isAttachment = disposition.value === 'attachment' || filename !== undefined || !part.contentType.value.startsWith('text/');
  if (!isAttachment && part.text !== undefined) {
    if (part.contentType.value === 'text/plain' && out.text === undefined) out.text = part.text;
    else if (part.contentType.value === 'text/html' && out.html === undefined) out.html = part.text;
    return;
  }
  const contentId = part.headers['content-id']?.[0]?.replace(/^<|>$/g, '');
  out.attachments.push({
    filename: filename ?? (contentId ? `inline-${contentId}` : `part-${out.attachments.length + 1}`),
    contentType: part.contentType.value,
    size: part.size,
    disposition: disposition.value === 'inline' ? 'inline' : 'attachment',
    ...(contentId ? { contentId } : {}),
  });
}

/**
 * Parses a raw RFC 5322 message: headers (unfolded, RFC 2047 decoded), nested
 * multipart bodies, base64 and quoted-printable, charsets via `TextDecoder`.
 * Attachments come back as metadata only.
 */
export function parseMime(raw: string | Uint8Array): ParsedMime {
  const root = parsePart(toBinaryString(raw).replace(/\r\n/g, '\n'), 0);
  const out: ParsedMime = { headers: root.headers, attachments: [], root };
  collect(root, out);
  if (out.text !== undefined) out.text = out.text.replace(/\n$/, '');
  return out;
}

export interface InboundFromMimeOptions {
  /** Defaults to `"mime"`. */
  provider?: string;
  providerId?: string;
  /** Defaults to the `Date` header, else now. */
  receivedAt?: Date;
}

/** Raw MIME (from IMAP, Gmail's `raw`, a `.eml` file, or a test fixture) → {@link InboundEmail}. */
export function inboundFromMime(raw: string | Uint8Array, opts: InboundFromMimeOptions = {}): InboundEmail {
  const parsed = parseMime(raw);
  const h = parsed.headers;
  const dateHeader = h['date']?.[0];
  const date = dateHeader ? new Date(dateHeader) : undefined;
  return createInboundEmail({
    provider: opts.provider ?? 'mime',
    providerId: opts.providerId,
    messageId: parseMessageIds(h['message-id']?.[0])[0],
    inReplyTo: parseMessageIds(h['in-reply-to']?.[0])[0],
    references: parseMessageIds(h['references']?.[0]),
    from: parseMailbox(h['from']?.[0] ?? '') ?? { address: 'unknown@invalid' },
    to: parseMailboxList(h['to']),
    cc: parseMailboxList(h['cc']),
    replyTo: parseMailbox(h['reply-to']?.[0] ?? ''),
    subject: h['subject']?.[0] ?? '',
    text: parsed.text,
    html: parsed.html,
    attachments: parsed.attachments,
    receivedAt: opts.receivedAt ?? (date && !Number.isNaN(date.getTime()) ? date : new Date()),
    headers: h,
  });
}
