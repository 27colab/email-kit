# @27colab/email-kit

The boring parts around sending transactional email, done carefully: retries, idempotency, suppression checks, EN/ES templates and a Resend adapter, with no runtime dependencies.

[![CI](https://github.com/27colab/email-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/27colab/email-kit/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@27colab/email-kit)](https://www.npmjs.com/package/@27colab/email-kit)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![types: TypeScript](https://img.shields.io/badge/types-TypeScript-3178c6.svg)](https://www.typescriptlang.org/)

## Why

- **Safe by default.** Every send checks the address, consults the suppression list, derives an idempotency key and retries only errors flagged retryable (backoff with jitter, `Retry-After` honoured).
- **Bot-friendly.** An "email me this" helper parses spoken addresses ("jane dot doe at example dot com", "arroba", "punto"), reads them back for confirmation, and only sends to the address the user gave for themselves.
- **Small enough to read.** About 590 lines of source, one provider (Resend over plain `fetch`); another provider is one class implementing `EmailProvider`. 31 offline tests with a `FakeProvider`.

## Install

```bash
npm install @27colab/email-kit
```

Node 18+, ESM, zero runtime dependencies, TypeScript types included.

## Quickstart

Runs offline with the fake provider: retries through two transient failures, dedupes a repeat, refuses a suppressed address.

```ts
import { createMailer, MemorySuppressionList, defineTemplate } from '@27colab/email-kit';
import { FakeProvider } from '@27colab/email-kit/testing';

const provider = new FakeProvider().failNext(2);   // two transient failures, then success (swap for ResendProvider)
const suppression = new MemorySuppressionList();
const mailer = createMailer({ provider, from: 'Acme <hello@example.com>', suppression });

const welcome = defineTemplate<{ name: string }>({
  id: 'welcome',
  defaultLocale: 'en',
  locales: {
    en: { subject: 'Welcome', text: 'Hi {{name}}!', html: '<p>Hi {{name}}!</p>' },
    es: { subject: 'Bienvenido', text: '¡Hola {{name}}!', html: '<p>¡Hola {{name}}!</p>' },
  },
});

await mailer.sendTemplate(welcome, 'ana@example.com', { name: 'Ana' }, { locale: 'es-MX' }); // falls back to "es"
console.log(provider.calls, 'provider calls;', provider.outbox[0]?.message.subject);

await mailer.sendTemplate(welcome, 'ana@example.com', { name: 'Ana' }, { locale: 'es-MX' }); // deduped
console.log('emails recorded:', provider.outbox.length);

await suppression.add('stop@example.com', 'unsubscribed');  // refused before the provider is called
await mailer.send({ to: 'stop@example.com', subject: 's', text: 't' }).catch((e) => console.log('refused:', e.reason));
```

Output:

```
3 provider calls; Bienvenido
emails recorded: 1
refused: suppressed
```

For real sending, replace the fake with `new ResendProvider({ apiKey: process.env.RESEND_API_KEY! })`.

## Bring your own keys

A **Resend** API key and a verified sending domain (SPF, DKIM, DMARC; until verified, most providers deliver only to the account owner). This library does not manage DNS.

## API

| Export | Purpose |
|---|---|
| `createMailer({ provider, from, suppression?, … })` | `send` and `sendTemplate` with validation, suppression, idempotency and retry. |
| `ResendProvider` | Resend adapter over plain `fetch`. |
| `EmailProvider` | Interface for your own provider. |
| `defineTemplate` | Typed templates with per-locale subject/text/html, locale fallback (`es-MX` → `es`) and HTML escaping. |
| `MemorySuppressionList`, `unsubscribeHeaders` | Suppression store interface plus `List-Unsubscribe` / one-click headers. |
| `batchAttachments` | Split files by count and total bytes; oversized files are returned, not dropped. |
| `createEmailMeThis`, `parseSpokenEmail` | Read-back confirmation and idempotent send for chat and voice bots. |
| `/testing` | `FakeProvider` with `failNext(n)` and an inspectable `outbox`. |

Full reference: **[docs.27colab.com/packages/email-kit](https://docs.27colab.com/packages/email-kit/)**

## Limits

- The default idempotency store is in memory (dedupes within a process); pass your own `IdempotencyStore` to dedupe across restarts.
- Identical content to the same recipient dedupes by default; pass `idempotencyScope` when you legitimately resend.
- Pre-1.0 and not audited; the API may change. Pin the exact version and review the code before relying on it.

## Not for you if…

- You want to replace Nodemailer, React Email or a full ESP SDK. There is no SMTP, no MJML, no queue and no inbound parsing.
- You need several real providers out of the box. Only Resend is included.
- You need something audited.

## Develop

```bash
npm ci && npm test && npm run typecheck
```

MIT, see [LICENSE](LICENSE). Not affiliated with Resend.

---

Built by [Jesus Vasquez](https://github.com/vasquezjesus2710) · [27 Colab](https://27colab.com)
