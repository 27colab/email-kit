import { createHmac, timingSafeEqual } from 'node:crypto';
import { parseMailbox, parseMailboxList, type Mailbox } from '../address.js';
import {
  InboundError,
  createInboundEmail,
  parseMessageIds,
  requestHeader,
  type InboundAttachment,
  type InboundEmail,
  type InboundHeaders,
  type InboundProvider,
  type InboundRequest,
} from '../inbound.js';

export interface WebhookVerifyOptions {
  /** Signing secret from the webhook's page in Resend (`whsec_…`). */
  secret: string;
  /** Reject timestamps further than this from `now`. Default 5 minutes. */
  toleranceMs?: number;
  /** Injectable clock for tests. */
  now?: () => Date;
}

/**
 * Verifies a Resend webhook request (Svix / Standard Webhooks scheme). Throws
 * {@link InboundError} with reason `bad-signature` or `stale-timestamp`.
 *
 * Verified against Resend's docs: the headers are `svix-id`, `svix-timestamp`,
 * `svix-signature`, the signature looks like `v1,<base64>`, and the raw body
 * must be used. Assumed from the Svix spec (not restated in Resend's docs): the
 * secret is `whsec_` + base64 key, the signed string is `${id}.${timestamp}.${body}`,
 * HMAC-SHA256, several space-separated signatures may be present.
 */
export function verifyResendWebhook(request: InboundRequest, opts: WebhookVerifyOptions): void {
  const id = requestHeader(request.headers, 'svix-id') ?? requestHeader(request.headers, 'webhook-id');
  const timestamp = requestHeader(request.headers, 'svix-timestamp') ?? requestHeader(request.headers, 'webhook-timestamp');
  const signature = requestHeader(request.headers, 'svix-signature') ?? requestHeader(request.headers, 'webhook-signature');
  if (!id || !timestamp || !signature) throw new InboundError('bad-signature', 'Missing webhook signature headers');

  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) throw new InboundError('stale-timestamp', 'Webhook timestamp is not a number');
  const skew = Math.abs((opts.now?.() ?? new Date()).getTime() - seconds * 1000);
  if (skew > (opts.toleranceMs ?? 5 * 60_000)) throw new InboundError('stale-timestamp', 'Webhook timestamp outside tolerance');

  const key = Buffer.from(opts.secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${request.body}`).digest();
  const ok = signature.split(/\s+/).some((entry) => {
    const [version, sig] = entry.split(',');
    if (version !== 'v1' || !sig) return false;
    const given = Buffer.from(sig, 'base64');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!ok) throw new InboundError('bad-signature', 'Webhook signature does not match');
}

/** Shape of the `email.received` webhook (verified against Resend's example payload). */
export interface ResendReceivedEvent {
  type: 'email.received';
  created_at: string;
  data: {
    email_id: string;
    created_at?: string;
    from: string;
    to: string[];
    cc?: string[];
    bcc?: string[];
    received_for?: string[];
    message_id?: string;
    subject?: string;
    attachments?: ResendAttachmentMeta[];
  };
}

export interface ResendAttachmentMeta {
  id: string;
  filename?: string;
  content_type?: string;
  content_disposition?: string;
  content_id?: string;
  size?: number;
}

/** Response of `GET /emails/receiving/{id}` (field names verified; the exact shape of `headers` is assumed). */
export interface ResendReceivedEmail {
  id: string;
  from: string;
  to: string[] | string;
  cc?: string[] | string | null;
  bcc?: string[] | string | null;
  reply_to?: string[] | string | null;
  subject?: string;
  text?: string | null;
  html?: string | null;
  headers?: Record<string, string | string[]> | Array<{ name: string; value: string }> | null;
  message_id?: string;
  created_at?: string;
  received_for?: string[];
  attachments?: ResendAttachmentMeta[];
}

export interface ResendAttachmentDownload extends InboundAttachment {
  downloadUrl: string;
  expiresAt?: string;
}

export interface ResendInboundProviderOptions extends Omit<WebhookVerifyOptions, 'secret'> {
  /** Webhook signing secret. Omit only when something upstream already verified the request. */
  webhookSecret?: string;
  /** API key, needed to fetch bodies and headers (the webhook carries metadata only). */
  apiKey?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

/**
 * Resend inbound: verifies the webhook, then fetches the full message because
 * Resend's `email.received` event carries metadata only (no body, no headers,
 * no attachment bytes). Attachments stay metadata; use {@link listAttachments}
 * for temporary download URLs.
 */
export class ResendInboundProvider implements InboundProvider {
  readonly name = 'resend';
  private readonly opts: ResendInboundProviderOptions;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ResendInboundProviderOptions = {}) {
    this.opts = opts;
    this.baseUrl = opts.baseUrl ?? 'https://api.resend.com';
    this.fetchImpl = opts.fetch ?? fetch;
  }

  /** Signature + timestamp check. No-op when no `webhookSecret` was configured. */
  verify(request: InboundRequest): void {
    if (!this.opts.webhookSecret) return;
    verifyResendWebhook(request, { secret: this.opts.webhookSecret, toleranceMs: this.opts.toleranceMs, now: this.opts.now });
  }

  /** Parses the verified body. Throws `unsupported-event` for anything but `email.received`. */
  parseEvent(body: string): ResendReceivedEvent {
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      throw new InboundError('bad-payload', 'Webhook body is not JSON');
    }
    const event = json as Partial<ResendReceivedEvent>;
    if (event?.type !== 'email.received') throw new InboundError('unsupported-event', `Unsupported event type: ${String(event?.type)}`);
    if (!event.data?.email_id) throw new InboundError('bad-payload', 'Webhook data.email_id missing');
    return event as ResendReceivedEvent;
  }

  async receive(request: InboundRequest): Promise<InboundEmail> {
    this.verify(request);
    const event = this.parseEvent(request.body);
    const full = await this.fetchReceived(event.data.email_id);
    return this.toInboundEmail(full, event);
  }

  /** `GET /emails/receiving/{id}`. */
  async fetchReceived(emailId: string): Promise<ResendReceivedEmail> {
    return this.get<ResendReceivedEmail>(`/emails/receiving/${encodeURIComponent(emailId)}`);
  }

  /** `GET /emails/receiving/{id}/attachments`: metadata plus temporary `downloadUrl`s. */
  async listAttachments(emailId: string): Promise<ResendAttachmentDownload[]> {
    const res = await this.get<{ data?: Array<ResendAttachmentMeta & { download_url?: string; expires_at?: string }> }>(
      `/emails/receiving/${encodeURIComponent(emailId)}/attachments`,
    );
    return (res.data ?? []).map((a) => ({ ...toAttachment(a), downloadUrl: a.download_url ?? '', expiresAt: a.expires_at }));
  }

  /** Builds the normalized message from the API response, with the webhook event (if any) filling gaps. */
  toInboundEmail(full: ResendReceivedEmail, event?: ResendReceivedEvent): InboundEmail {
    const headers = normalizeHeaders(full.headers);
    const messageId = parseMessageIds(full.message_id ?? event?.data.message_id ?? headers['message-id']?.[0])[0];
    const created = full.created_at ?? event?.data.created_at ?? event?.created_at ?? headers['date']?.[0];
    const receivedAt = created ? new Date(created) : new Date();
    return createInboundEmail({
      provider: this.name,
      providerId: full.id ?? event?.data.email_id,
      messageId,
      from: parseMailbox(full.from ?? event?.data.from ?? '') ?? { address: 'unknown@invalid' },
      to: parseMailboxList(full.to ?? event?.data.to),
      cc: parseMailboxList(full.cc ?? event?.data.cc ?? undefined),
      replyTo: firstMailbox(full.reply_to) ?? firstMailbox(headers['reply-to']),
      subject: full.subject ?? event?.data.subject ?? headers['subject']?.[0] ?? '',
      text: full.text ?? undefined,
      html: full.html ?? undefined,
      attachments: (full.attachments ?? event?.data.attachments ?? []).map(toAttachment),
      receivedAt: Number.isNaN(receivedAt.getTime()) ? new Date() : receivedAt,
      headers,
    });
  }

  private async get<T>(path: string): Promise<T> {
    if (!this.opts.apiKey) throw new InboundError('not-configured', 'ResendInboundProvider: apiKey is required to fetch received emails');
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, { headers: { Authorization: `Bearer ${this.opts.apiKey}` } });
    } catch (cause) {
      throw new InboundError('fetch-failed', `Resend network error: ${(cause as Error).message}`);
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      throw new InboundError('fetch-failed', `Resend GET ${path} failed (${res.status}): ${detail}`, res.status);
    }
    return (await res.json()) as T;
  }
}

function firstMailbox(value: string[] | string | null | undefined): Mailbox | undefined {
  return parseMailboxList(value ?? undefined)[0];
}

function toAttachment(a: ResendAttachmentMeta): InboundAttachment {
  return {
    filename: a.filename ?? a.id,
    contentType: a.content_type ?? 'application/octet-stream',
    size: a.size,
    disposition: a.content_disposition === 'inline' ? 'inline' : 'attachment',
    ...(a.content_id ? { contentId: a.content_id.replace(/^<|>$/g, '') } : {}),
    providerRef: a.id,
  };
}

function normalizeHeaders(h: ResendReceivedEmail['headers']): InboundHeaders {
  const out: InboundHeaders = {};
  if (!h) return out;
  const push = (name: string, value: string | string[]) => {
    (out[name.toLowerCase()] ??= []).push(...(Array.isArray(value) ? value : [value]));
  };
  if (Array.isArray(h)) for (const { name, value } of h) push(name, value);
  else for (const [name, value] of Object.entries(h)) push(name, value);
  return out;
}
