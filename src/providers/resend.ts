import { EmailSendError, type EmailMessage, type EmailProvider, type SendOptions, type SendResult } from '../types.js';

export interface ResendProviderOptions {
  apiKey: string;
  baseUrl?: string;
  /** Inject for tests or custom agents. Defaults to global fetch. */
  fetch?: typeof fetch;
}

function toBase64(content: Uint8Array | string): string {
  return typeof content === 'string' ? content : Buffer.from(content).toString('base64');
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

/** Resend over plain `fetch` (no SDK). Retry classification: 429 and 5xx are retryable. */
export class ResendProvider implements EmailProvider {
  readonly name = 'resend';
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ResendProviderOptions) {
    if (!opts.apiKey?.trim()) throw new Error('ResendProvider: apiKey is required');
    this.apiKey = opts.apiKey.trim();
    this.baseUrl = opts.baseUrl ?? 'https://api.resend.com';
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async send(message: EmailMessage & { from: string }, options: SendOptions = {}): Promise<SendResult> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

    const payload: Record<string, unknown> = {
      from: message.from,
      to: [message.to],
      subject: message.subject,
    };
    if (message.cc?.length) payload.cc = message.cc;
    if (message.text) payload.text = message.text;
    if (message.html) payload.html = message.html;
    if (message.replyTo) payload.reply_to = message.replyTo;
    if (message.headers) payload.headers = message.headers;
    if (message.tags) payload.tags = Object.entries(message.tags).map(([name, value]) => ({ name, value }));
    if (message.attachments?.length) {
      payload.attachments = message.attachments.map((a) => ({
        filename: a.filename,
        content: toBase64(a.content),
        ...(a.contentType ? { content_type: a.contentType } : {}),
      }));
    }

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/emails`, { method: 'POST', headers, body: JSON.stringify(payload) });
    } catch (cause) {
      throw new EmailSendError(`Resend network error: ${(cause as Error).message}`, true);
    }

    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      const retryable = res.status === 429 || res.status >= 500;
      throw new EmailSendError(
        `Resend send failed (${res.status}): ${detail}`,
        retryable,
        res.status,
        parseRetryAfter(res.headers.get('retry-after')),
      );
    }
    const data = (await res.json().catch(() => ({}))) as { id?: string };
    return { id: data.id ?? '', provider: this.name };
  }
}
