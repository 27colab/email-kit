# @27colab/email-kit

A small, dependency-free TypeScript toolkit for sending transactional email *safely*: provider-agnostic send interface, a Resend adapter, retries, idempotency, suppression-list checks, EN/ES templates, attachment batching, and an "email me this" helper for chat and voice bots.

## Positioning (read this first)

- It is a **reference implementation of the boring parts around sending**, extracted from patterns I use in my own projects and rewritten clean. It is ~600 lines you can read in ten minutes.
- It is **not** a replacement for Nodemailer, React Email, or a full ESP SDK. There is no SMTP, no MJML, no queue, no inbound parsing.
- One real provider (Resend, over plain `fetch`). Adding another is one class implementing `EmailProvider`.
- Pre-1.0: the API may change. Not audited for production use; review it before you rely on it.

## Install

```bash
npm install @27colab/email-kit
```

Node 18+, ESM only. No runtime dependencies.

## Usage

```ts
import { createMailer, ResendProvider, MemorySuppressionList, defineTemplate } from '@27colab/email-kit';

const suppression = new MemorySuppressionList(); // swap for a DB-backed SuppressionList

const mailer = createMailer({
  provider: new ResendProvider({ apiKey: process.env.RESEND_API_KEY! }),
  from: 'Acme <hello@example.com>',
  suppression,
});

const welcome = defineTemplate<{ name: string }>({
  id: 'welcome',
  defaultLocale: 'en',
  locales: {
    en: { subject: 'Welcome', text: 'Hi {{name}}!', html: '<p>Hi {{name}}!</p>' },
    es: { subject: 'Bienvenido', text: '¡Hola {{name}}!', html: '<p>¡Hola {{name}}!</p>' },
  },
});

await mailer.sendTemplate(welcome, 'ana@example.com', { name: 'Ana' }, { locale: 'es-MX' }); // falls back to "es"
```

### What `send` does, in order

1. Validates the address and that there is content.
2. Refuses if the recipient is on the suppression list (`EmailRefusedError`, reason `suppressed`). Bypass is explicit per call.
3. Derives (or accepts) an **idempotency key** and returns the earlier result if one exists. The key is also sent to the provider (`Idempotency-Key` for Resend).
4. Calls the provider with **retry**: exponential backoff with jitter, `Retry-After` honored, only for errors flagged `retryable` (Resend: network errors, 429, 5xx).

The default idempotency store is in-memory, so it dedupes within a process. Pass your own `IdempotencyStore` (Redis, a DB table) to dedupe across restarts. Identical content to the same recipient dedupes by default; pass `idempotencyScope` (e.g. an order id) when you legitimately resend the same text.

### Unsubscribe headers

```ts
unsubscribeHeaders({ httpsUrl: 'https://example.com/unsubscribe/abc' });
// { 'List-Unsubscribe': '<https://...>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
```

You host the endpoint and call `suppression.add(address, 'unsubscribed')` from it.

### Attachment batching

```ts
const { batches, oversized } = batchAttachments(files, { maxBytes: 15 * 1024 * 1024, maxCount: 10 });
for (const batch of batches) await mailer.send({ to, subject, text, attachments: batch });
```

Files too large on their own are returned in `oversized` rather than dropped silently. Send those as links.

### "Email me this" for bots

```ts
const emailMeThis = createEmailMeThis(mailer, { locale: 'en' });

await emailMeThis({ address: 'jane dot doe at example dot com', confirmed: false, subject, text, requestId });
// -> { status: 'needs-confirmation', readBack: 'j a n e dot d o e at ...' }  (say it back, get a yes)
await emailMeThis({ address, confirmed: true, subject, text, requestId });
// -> { status: 'sent' }  (a repeated tool call with the same requestId will not send twice)
```

`parseSpokenEmail` understands "dot / at / dash / underscore / plus" and Spanish "punto / arroba / guion / guion bajo / más". It returns `undefined` for anything that is not a valid address, so you re-prompt rather than guess. The helper only sends to the address the user supplied for themselves; it has no way to take a different recipient.

### Testing

```ts
import { FakeProvider } from '@27colab/email-kit/testing';

const provider = new FakeProvider().failNext(2); // two transient failures, then success
const mailer = createMailer({ provider, from: 'a@example.com' });
await mailer.send({ to: 'b@example.com', subject: 's', text: 't' });
provider.outbox; // inspect what was "sent"
```

## DNS / deliverability

Sending from your own domain needs SPF, DKIM and DMARC records. Your provider generates the DKIM values; follow their domain-verification guide (for Resend: Domains in the dashboard). Until a domain is verified, most providers only deliver to the account owner. This library does not manage DNS.

## Development

```bash
npm install
npm run typecheck && npm test && npm run build
```

## License

MIT. Copyright (c) 2026 27 Colab LLC.
