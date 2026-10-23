# Changelog

## Unreleased (proposed 0.2.0, minor)

Added, inbound email:

- `InboundEmail`: one normalized shape for received mail (message id, thread key, participants, text/html, `replyText` with quoted history stripped, attachment metadata, headers, provider).
- `ResendInboundProvider` and `verifyResendWebhook`: signature check for the `email.received` webhook, then `GET /emails/receiving/{id}` for the body and headers; `listAttachments` for temporary download URLs.
- `inboundFromMime` / `parseMime`: raw RFC 5322 parsing without dependencies (nested multipart, base64, quoted-printable, charsets, RFC 2047 and RFC 2231), so an IMAP or Gmail source can be plugged in.
- Guards: `isAutoResponder`, `isLoop` (own ids, own address, hop header, sender bursts), `inspectInbound` with suppression-list flagging.
- Replies: `buildReply`, `sendReply`, `quoteOriginal`, `replySubject` (EN/ES prefixes, no stacking).
- `/testing`: `FakeInboundProvider`, `fakeInbound`, `inboundFixtures`.
- `EmailMessage.cc` (validated by the mailer, forwarded by `ResendProvider`).

No breaking changes. Existing exports and behaviour are unchanged.

## 0.1.0

Initial release: Resend adapter, EN/ES templates, idempotency, retry, suppression, attachment batching, "email me this" capture helper, `FakeProvider`.
