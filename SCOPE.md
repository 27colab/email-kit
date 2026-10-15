# Scope

## Where this came from

Two private codebases were surveyed for ideas. Nothing was copied.

- A multi-tenant voice platform has a ~30-line `fetch` to Resend's HTTP API and a
  small "email the caller their own info" skill (validate address, require subject
  and body, send). Both are tied to that platform's skill SDK and tenant model.
- A client-owned deployment has a handler that emails listings with PDF flyers
  attached. It is client-specific; only the *idea* (send attachments, cap what you
  attach) informed the generic attachment batcher.

Honest summary: the existing code is thin. The package below is mostly **new,
clean-room design** around the one thing that was proven useful: calling a provider
over plain `fetch` and being careful about who you send to.

## In (generic, published)

| Piece | Why it is generic |
|---|---|
| `EmailProvider` interface + `ResendProvider` (plain `fetch`, no SDK) | Any app sending transactional mail |
| `FakeProvider` (`/testing`) | Lets consumers test without network |
| `withRetry` (backoff, jitter, `Retry-After`, retryable vs permanent errors) | Provider-agnostic |
| Idempotency (stable key, pluggable store, provider header passthrough) | Prevents double-sends on retries |
| `SuppressionList` + unsubscribe helpers (`List-Unsubscribe`, one-click) | Compliance hygiene, no vertical logic |
| Typed templates with EN/ES (any locale) + safe HTML escaping | i18n layer without a template engine |
| Attachment batching by count and total bytes | Providers cap message size |
| "Email me this" helper: spoken/typed address parsing, read-back, self-only guard | Reusable by chat and voice bots |

## Out (stays private)

Tenants, per-tenant sender identity, prompts and tool descriptions, vertical
templates (listings, liens, reminders copy), real domains, DKIM/DNS records for any
real domain, API keys, persistence layers, any client branding.

## Considered and dropped

- DKIM/SPF/DMARC "setup notes": the private notes are checklists for specific
  domains. A generic version would just restate the Resend docs, so it is a short
  pointer in the README, not a feature.
- Reminder scheduling: that is a scheduler concern, not email.
- Inbound email parsing: no source material, different problem.

## Verdict

Small but coherent (~600 lines of source). Worth a repo only as a *reference
implementation* of "send email safely": idempotent, retried, suppression-aware,
bilingual. It is not a competitor to Nodemailer or React Email and says so.
