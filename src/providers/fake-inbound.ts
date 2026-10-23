import { createInboundEmail, type InboundEmail, type InboundInput, type InboundProvider, type InboundRequest } from '../inbound.js';
import { inboundFromMime } from '../mime.js';
import { DEFAULT_HOP_HEADER } from '../guards.js';

/**
 * Inbound provider for tests: `receive` treats the request body as raw MIME
 * (post a fixture to your handler) and records everything it produced.
 */
export class FakeInboundProvider implements InboundProvider {
  readonly name = 'fake';
  readonly received: InboundEmail[] = [];

  async receive(request: InboundRequest): Promise<InboundEmail> {
    const email = inboundFromMime(request.body, { provider: this.name });
    this.received.push(email);
    return email;
  }

  reset(): void {
    this.received.length = 0;
  }
}

/** An {@link InboundEmail} with sensible defaults; override any field. */
export function fakeInbound(overrides: Partial<InboundInput> = {}): InboundEmail {
  return createInboundEmail({
    provider: 'fake',
    messageId: 'msg-1@example.com',
    from: { name: 'Ana García', address: 'ana@example.com' },
    to: [{ address: 'hello@example.com' }],
    subject: 'Hola',
    text: 'Hola, ¿tienen disponibilidad el viernes?',
    receivedAt: new Date('2026-10-23T15:00:00Z'),
    ...overrides,
  });
}

const CRLF = (s: string) => s.replace(/\n/g, '\r\n');

/** Raw MIME fixtures. Run them through `inboundFromMime` or `FakeInboundProvider`. */
export const inboundFixtures = {
  /** Single-part text/plain, proper threading headers. */
  plain: CRLF(`From: Ana García <ana@example.com>
To: Acme <hello@example.com>
Subject: Re: Your quote
Date: Fri, 23 Oct 2026 10:00:00 -0500
Message-ID: <reply-1@mail.example.com>
In-Reply-To: <quote-1@example.com>
References: <quote-1@example.com>
Content-Type: text/plain; charset=utf-8

Thanks, Friday at 10 works for me.

On Thu, 22 Oct 2026 at 18:02, Acme <hello@example.com> wrote:
> Here is the quote you asked for.
`),

  /** multipart/mixed wrapping multipart/alternative, with a PDF and an inline image. */
  multipart: CRLF(`From: "Doe, Jane" <jane@example.com>
To: hello@example.com, Bob <bob@example.com>
Cc: carla@example.com
Reply-To: jane.doe@example.org
Subject: Floor plans
Date: Fri, 23 Oct 2026 11:00:00 +0000
Message-ID: <plans-1@example.com>
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="outer"

--outer
Content-Type: multipart/alternative; boundary="inner"

--inner
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: 7bit

Plans attached. Let me know what you think.
--inner
Content-Type: text/html; charset=utf-8
Content-Transfer-Encoding: quoted-printable

<p>Plans <b>attached</b>. Let me know what you think.</p><img src=3D"cid:lo=
go1">
--inner--
--outer
Content-Type: application/pdf; name="plans.pdf"
Content-Disposition: attachment; filename="plans.pdf"
Content-Transfer-Encoding: base64

JVBERi0xLjQKJcOkw7zDtsOfCjEgMCBvYmoKPDwvVHlwZS9DYXRhbG9nPj4KZW5kb2JqCg==
--outer
Content-Type: image/png
Content-ID: <logo1>
Content-Disposition: inline; filename="logo.png"
Content-Transfer-Encoding: base64

iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==
--outer--
`),

  /** Quoted-printable Spanish body and an RFC 2047 encoded subject and name. */
  quotedPrintableSpanish: CRLF(`From: =?UTF-8?Q?Jos=C3=A9_Mu=C3=B1oz?= <jose@example.com>
To: hello@example.com
Subject: =?UTF-8?B?UmU6IENvdGl6YWNpw7NuIGRlbCBqYXJkw61u?=
Date: Fri, 23 Oct 2026 12:00:00 -0600
Message-ID: <jose-1@example.com>
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: quoted-printable

Buenos d=C3=ADas, =C2=BFpodr=C3=ADan venir el mi=C3=A9rcoles por la ma=C3=B1=
ana?

Gracias,
Jos=C3=A9

El jue, 22 oct 2026 a las 18:02, Acme <hello@example.com> escribi=C3=B3:
> Adjunto la cotizaci=C3=B3n.
`),

  /** Out-of-office with RFC 3834 headers. */
  autoResponder: CRLF(`From: Bob <bob@example.com>
To: hello@example.com
Subject: Automatic reply: Floor plans
Date: Fri, 23 Oct 2026 11:00:05 +0000
Message-ID: <ooo-1@example.com>
In-Reply-To: <plans-1@example.com>
Auto-Submitted: auto-replied
Precedence: bulk
X-Auto-Response-Suppress: All
Content-Type: text/plain; charset=utf-8

I am out of the office until Monday.
`),

  /** Our own reply bouncing back: hop counter at the limit, our id in References. */
  loop: CRLF(`From: Acme <hello@example.com>
To: hello@example.com
Subject: Re: Hola
Date: Fri, 23 Oct 2026 11:00:09 +0000
Message-ID: <loop-5@example.com>
References: <ours-1@example.com> <ours-2@example.com>
${DEFAULT_HOP_HEADER}: 5
Content-Type: text/plain; charset=utf-8

Thanks for your message.
`),
};

export type InboundFixtureName = keyof typeof inboundFixtures;

/** A fixture already parsed into an {@link InboundEmail}. */
export function inboundFixture(name: InboundFixtureName): InboundEmail {
  return inboundFromMime(inboundFixtures[name], { provider: 'fake' });
}
