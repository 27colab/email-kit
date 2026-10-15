export interface Attachment {
  filename: string;
  /** Raw bytes, or an already base64-encoded string. */
  content: Uint8Array | string;
  contentType?: string;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  from?: string;
  replyTo?: string;
  headers?: Record<string, string>;
  attachments?: Attachment[];
  /** Free-form labels forwarded to providers that support them. */
  tags?: Record<string, string>;
}

export interface SendOptions {
  /** Sent to the provider so a retried request cannot deliver twice. */
  idempotencyKey?: string;
}

export interface SendResult {
  id: string;
  provider: string;
}

export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage & { from: string }, options?: SendOptions): Promise<SendResult>;
}

/** Thrown by providers. `retryable` drives {@link withRetry}. */
export class EmailSendError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'EmailSendError';
  }
}

/** Thrown when a send is refused before reaching the provider. */
export class EmailRefusedError extends Error {
  constructor(
    readonly reason: 'suppressed' | 'invalid-address' | 'missing-content',
    message: string,
  ) {
    super(message);
    this.name = 'EmailRefusedError';
  }
}
