import { isValidEmail } from './address.js';
import { MemoryIdempotencyStore, deriveIdempotencyKey, type IdempotencyStore } from './idempotency.js';
import { withRetry, type RetryOptions } from './retry.js';
import type { SuppressionList } from './suppression.js';
import { renderTemplate, type Locale, type TemplateDefinition } from './templates.js';
import {
  EmailRefusedError,
  type EmailMessage,
  type EmailProvider,
  type SendResult,
} from './types.js';

export interface MailerOptions {
  provider: EmailProvider;
  /** Default `from`, e.g. `"Acme <hello@example.com>"`. Required unless every message sets it. */
  from?: string;
  suppression?: SuppressionList;
  /** Defaults to an in-memory store; supply a durable one to dedupe across restarts. */
  idempotencyStore?: IdempotencyStore;
  retry?: RetryOptions | false;
}

export interface SendCallOptions {
  /** Explicit key, or a scope mixed into the derived key. Explicit wins. */
  idempotencyKey?: string;
  idempotencyScope?: string;
  /** Transactional mail the recipient must receive (e.g. password reset) can bypass suppression for `unsubscribed` only. Off by default. */
  bypassSuppression?: boolean;
}

export interface Mailer {
  send(message: EmailMessage, options?: SendCallOptions): Promise<SendResult>;
  sendTemplate<V extends Record<string, string | number>>(
    template: TemplateDefinition<V>,
    to: string,
    vars: V,
    options?: SendCallOptions & { locale?: Locale; message?: Partial<EmailMessage> },
  ): Promise<SendResult>;
}

export function createMailer(opts: MailerOptions): Mailer {
  const store = opts.idempotencyStore ?? new MemoryIdempotencyStore();

  const send: Mailer['send'] = async (message, options = {}) => {
    if (!isValidEmail(message.to) || message.cc?.some((a) => !isValidEmail(a))) {
      throw new EmailRefusedError('invalid-address', `Invalid recipient address`);
    }
    if (!message.text && !message.html) {
      throw new EmailRefusedError('missing-content', 'Message needs text or html');
    }
    const from = message.from ?? opts.from;
    if (!from) throw new Error('No "from" address: set it on the mailer or the message');

    if (opts.suppression && !options.bypassSuppression && (await opts.suppression.isSuppressed(message.to))) {
      throw new EmailRefusedError('suppressed', 'Recipient is on the suppression list');
    }

    const key = options.idempotencyKey ?? deriveIdempotencyKey(message, options.idempotencyScope);
    const prior = await store.get(key);
    if (prior) return prior;

    const attempt = () => opts.provider.send({ ...message, from }, { idempotencyKey: key });
    const result = opts.retry === false ? await attempt() : await withRetry(attempt, opts.retry);
    await store.set(key, result);
    return result;
  };

  return {
    send,
    async sendTemplate(template, to, vars, options = {}) {
      const rendered = renderTemplate(template, vars, options.locale);
      return send(
        { ...options.message, to, subject: rendered.subject, text: rendered.text, html: rendered.html },
        options,
      );
    },
  };
}
