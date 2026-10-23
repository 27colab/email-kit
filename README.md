# @27colab/email-kit

The boring parts around sending and receiving transactional email, done carefully: retries, idempotency, suppression checks, EN/ES templates, a Resend adapter, and inbound parsing with auto-responder and loop guards, with no runtime dependencies.

[![CI](https://github.com/27colab/email-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/27colab/email-kit/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@27colab/email-kit)](https://www.npmjs.com/package/@27colab/email-kit)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![types: TypeScript](https://img.shields.io/badge/types-TypeScript-3178c6.svg)](https://www.typescriptlang.org/)

## Why

- **Safe by default.** Every send checks the address, consults the suppression list, derives an idempotency key and retries only errors flagged retryable (backoff with jitter, `Retry-After` honoured).
- **Bot-friendly.** An "email me this" helper parses spoken addresses ("jane dot doe at example dot com", "arroba", "punto"), reads them back for confirmation, and only sends to the address the user gave for themselves.
- **Replies that thread.** Inbound mail is normalized into one `InboundEmail` (thread key, reply text with the quoted history stripped, attachment metadata), auto-responders and mail loops are flagged before you answer, and `sendReply` sets `In-Reply-To`/`References` and goes through the same mailer.
- **Small enough to read.** About 1,700 lines of source, one provider (Resend over plain `fetch`, outbound and inbound); another provider is one class implementing `EmailProvider` or `InboundProvider`. 99 offline tests with `FakeProvider` and `FakeInboundProvider`.

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

## Receiving email

Receive a webhook, drop auto-responders and loops, reply in the thread. Works with any framework: hand it the raw body string and the request headers.

```ts
import { ResendInboundProvider, ResendProvider, createMailer, inspectInbound, sendReply } from '@27colab/email-kit';

const mailer = createMailer({ provider: new ResendProvider({ apiKey: process.env.RESEND_API_KEY! }), from: 'Acme <hello@example.com>' });
const inbound = new ResendInboundProvider({ webhookSecret: process.env.RESEND_WEBHOOK_SECRET!, apiKey: process.env.RESEND_API_KEY! });

export async function handleWebhook(rawBody: string, headers: Record<string, string>) {
  const email = await inbound.receive({ body: rawBody, headers }); // verifies the signature, fetches the body
  const flags = await inspectInbound(email, { loop: { ourAddresses: ['hello@example.com'] } });
  if (flags.autoResponder || flags.loop) return; // out-of-office, bounces, list mail, our own mail bouncing back
  if (flags.suppressedSender) console.warn('sender is suppressed; replying anyway is your call');

  console.log(email.threadKey, email.from.address, email.replyText); // replyText: quoted history already stripped
  await sendReply(mailer, email, { text: 'Thanks, we will get back to you today.' });
  // → Re: <subject>, In-Reply-To/References set, quote appended, deduped per inbound message, suppression applied
}
```

Offline, the same flow runs with `FakeInboundProvider` (treats the posted body as raw MIME) and the `inboundFixtures` (plain, multipart, quoted-printable Spanish, auto-responder, loop) from `@27colab/email-kit/testing`. For Gmail or IMAP, `inboundFromMime(raw)` parses an RFC 5322 message directly: nested multipart, base64, quoted-printable, charsets, RFC 2047 headers; attachments come back as metadata, never bytes.

What `inspectInbound` flags, each a pure function you can also call alone:

- `isAutoResponder`: `Auto-Submitted`, `Precedence: bulk/list`, `X-Autoreply`, list headers, null `Return-Path`, daemon senders, EN/ES subjects ("Automatic reply", "Fuera de la oficina", "Undeliverable").
- `isLoop`: our own Message-ID or address, too many of our ids in `References`, a burst from one sender, or the `X-Email-Kit-Hops` counter (bumped by every `buildReply`) reaching its limit.
- `suppressedSender`: the sender is on your suppression list. Flagged, not dropped.

## Bring your own keys

A **Resend** API key and a verified sending domain (SPF, DKIM, DMARC; until verified, most providers deliver only to the account owner). For receiving, a Resend inbound domain or address and a webhook signing secret. This library does not manage DNS.

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
| `ResendInboundProvider`, `verifyResendWebhook` | Verify the `email.received` webhook and fetch the full message into an `InboundEmail`. |
| `inboundFromMime`, `parseMime` | Raw RFC 5322 → `InboundEmail`, for IMAP/Gmail sources or `.eml` files. |
| `inspectInbound`, `isAutoResponder`, `isLoop` | Guards as pure functions; nothing is dropped silently. |
| `buildReply`, `sendReply`, `quoteOriginal`, `replySubject` | Threaded replies (`In-Reply-To`, `References`, one `Re:`, EN/ES) through the mailer. |
| `threadKey`, `stripQuotedReply`, `createInboundEmail` | Building blocks for your own inbound provider. |
| `/testing` | `FakeProvider` with `failNext(n)` and an `outbox`; `FakeInboundProvider`, `fakeInbound` and `inboundFixtures`. |

Full reference: **[docs.27colab.com/packages/email-kit](https://docs.27colab.com/packages/email-kit/)**

## Limits

- The default idempotency store is in memory (dedupes within a process); pass your own `IdempotencyStore` to dedupe across restarts.
- Identical content to the same recipient dedupes by default; pass `idempotencyScope` when you legitimately resend.
- Resend's `email.received` webhook carries metadata only, so `receive` makes one API call per message to fetch the body and headers; `apiKey` is required for that. Attachment bytes are never fetched; `listAttachments` returns temporary download URLs.
- Verified against Resend's docs (2026-10-23): the event and `GET /emails/receiving/{id}` field names, the attachment endpoint, and the `svix-*` signature headers. Assumed from the Svix spec and not yet tried against a live account: the `whsec_` secret format, the `id.timestamp.body` signed string, and the exact shape of `headers` in the API response (object and `{name, value}[]` are both accepted).
- Thread keys follow `References`; a client that drops them starts a new thread. `subjectThreadKey` is there if you want to merge by subject and participants yourself.
- Pre-1.0 and not audited; the API may change. Pin the exact version and review the code before relying on it.

## Not for you if…

- You want to replace Nodemailer, React Email or a full ESP SDK. There is no SMTP, no IMAP client, no MJML and no queue.
- You need several real providers out of the box. Only Resend is included.
- You need something audited.

## Develop

```bash
npm ci && npm test && npm run typecheck
```

MIT, see [LICENSE](LICENSE). Not affiliated with Resend.

---

Built by [Jesus Vasquez](https://github.com/vasquezjesus2710) · [27 Colab](https://27colab.com)
