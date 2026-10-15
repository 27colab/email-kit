import { EmailSendError, type EmailMessage, type EmailProvider, type SendOptions, type SendResult } from '../types.js';

export interface SentEmail {
  id: string;
  message: EmailMessage & { from: string };
  idempotencyKey?: string;
}

/**
 * In-memory provider for tests. Records an outbox and can be told to fail.
 * Like real providers that honor idempotency keys, a repeated key returns the
 * original result without recording a second email.
 */
export class FakeProvider implements EmailProvider {
  readonly name = 'fake';
  readonly outbox: SentEmail[] = [];
  /** Number of upcoming calls that should fail. */
  private failures: EmailSendError[] = [];
  calls = 0;
  private byKey = new Map<string, SendResult>();

  failNext(times = 1, error = new EmailSendError('fake transient failure', true, 503)): this {
    this.failures.push(...Array.from({ length: times }, () => error));
    return this;
  }

  async send(message: EmailMessage & { from: string }, options: SendOptions = {}): Promise<SendResult> {
    this.calls++;
    const failure = this.failures.shift();
    if (failure) throw failure;
    if (options.idempotencyKey) {
      const prior = this.byKey.get(options.idempotencyKey);
      if (prior) return prior;
    }
    const id = `fake_${this.outbox.length + 1}`;
    this.outbox.push({ id, message, idempotencyKey: options.idempotencyKey });
    const result = { id, provider: this.name };
    if (options.idempotencyKey) this.byKey.set(options.idempotencyKey, result);
    return result;
  }

  reset(): void {
    this.outbox.length = 0;
    this.failures = [];
    this.byKey.clear();
    this.calls = 0;
  }
}
