import { normalizeEmail } from './address.js';
import type { SuppressionList } from './suppression.js';
import { getHeader, type InboundEmail } from './inbound.js';

export type AutoResponderReason =
  | 'auto-submitted'
  | 'precedence'
  | 'x-autoreply'
  | 'list'
  | 'null-return-path'
  | 'daemon-sender'
  | 'subject';

const AUTO_SUBJECT = /^\s*(?:re\s*:\s*)?(?:auto(?:matic)?[\s-]*(?:reply|response|respuesta)|automatic reply|out of (?:the )?office|respuesta autom[aá]tica|fuera de (?:la )?oficina|ausente|delivery (?:status notification|failure|has failed)|undeliverable|undelivered mail|mail delivery (?:failed|failure)|returned mail|no se pudo entregar)/i;

/** Why a message looks machine-generated (RFC 3834 and the usual vendor headers), or `undefined` for a human message. */
export function autoResponderReason(email: Pick<InboundEmail, 'headers' | 'subject' | 'from'>): AutoResponderReason | undefined {
  const auto = getHeader(email, 'auto-submitted')?.toLowerCase();
  if (auto && auto !== 'no') return 'auto-submitted';
  const precedence = getHeader(email, 'precedence')?.toLowerCase();
  if (precedence && ['bulk', 'junk', 'list', 'auto_reply'].includes(precedence)) return 'precedence';
  if (['x-autoreply', 'x-autorespond', 'x-autoresponder', 'x-auto-reply'].some((h) => getHeader(email, h) !== undefined)) return 'x-autoreply';
  if (getHeader(email, 'list-id') !== undefined || getHeader(email, 'list-unsubscribe') !== undefined) return 'list';
  const returnPath = getHeader(email, 'return-path')?.trim();
  if (returnPath === '<>') return 'null-return-path';
  if (/^(mailer-daemon|postmaster|no-?reply|do-?not-?reply)@/i.test(email.from.address)) return 'daemon-sender';
  if (AUTO_SUBJECT.test(email.subject)) return 'subject';
  return undefined;
}

export function isAutoResponder(email: Pick<InboundEmail, 'headers' | 'subject' | 'from'>): boolean {
  return autoResponderReason(email) !== undefined;
}

export interface LoopOptions {
  /** Message-IDs this system sent (any iterable, or a predicate). */
  ourMessageIds?: Iterable<string> | ((id: string) => boolean);
  /** Addresses this system sends from; mail *from* one of them is ours coming back. */
  ourAddresses?: string[];
  /** How many of our own ids may appear in `References` before the thread counts as a loop. Default 10. */
  maxOwnReferences?: number;
  /** `receivedAt` of earlier messages from the same sender (the caller keeps this history). */
  recentFromSender?: Date[];
  /** Window for `recentFromSender`. Default 60 000 ms. */
  windowMs?: number;
  /** Messages from one sender allowed inside the window before it is a loop. Default 3. */
  maxPerWindow?: number;
  /** Numeric header incremented by {@link buildReply}. Default `X-Email-Kit-Hops`. */
  hopHeader?: string;
  /** Loop when the hop header reaches this value. Default 5. */
  hopLimit?: number;
}

export type LoopReason = 'own-message-id' | 'own-sender' | 'own-references' | 'sender-rate' | 'hop-limit';

export const DEFAULT_HOP_HEADER = 'X-Email-Kit-Hops';

/** Why a message looks like mail bouncing between automated systems, or `undefined`. Pure: all state comes in via `opts`. */
export function loopReason(email: InboundEmail, opts: LoopOptions = {}): LoopReason | undefined {
  const isOurs = ourIdPredicate(opts.ourMessageIds);
  if (isOurs(email.messageId)) return 'own-message-id';
  const ours = new Set((opts.ourAddresses ?? []).map(normalizeEmail));
  if (ours.has(normalizeEmail(email.from.address))) return 'own-sender';
  const ownRefs = email.references.filter(isOurs).length;
  if (ownRefs >= (opts.maxOwnReferences ?? 10)) return 'own-references';
  const window = opts.windowMs ?? 60_000;
  const recent = (opts.recentFromSender ?? []).filter((d) => Math.abs(email.receivedAt.getTime() - d.getTime()) <= window).length;
  if (recent >= (opts.maxPerWindow ?? 3)) return 'sender-rate';
  const hops = Number(getHeader(email, opts.hopHeader ?? DEFAULT_HOP_HEADER) ?? '0');
  if (Number.isFinite(hops) && hops >= (opts.hopLimit ?? 5)) return 'hop-limit';
  return undefined;
}

export function isLoop(email: InboundEmail, opts: LoopOptions = {}): boolean {
  return loopReason(email, opts) !== undefined;
}

function ourIdPredicate(ids: LoopOptions['ourMessageIds']): (id: string) => boolean {
  if (!ids) return () => false;
  if (typeof ids === 'function') return ids;
  const set = new Set(ids);
  return (id) => set.has(id);
}

export interface InboundFlags {
  autoResponder?: AutoResponderReason;
  loop?: LoopReason;
  /** The sender is on the suppression list. Flagged, never dropped: you decide whether to reply. */
  suppressedSender: boolean;
  /** Convenience: `true` when any flag is set. */
  flagged: boolean;
}

export interface InspectOptions {
  suppression?: SuppressionList;
  loop?: LoopOptions;
}

/** Runs every guard once. Nothing is thrown or dropped; callers act on the flags. */
export async function inspectInbound(email: InboundEmail, opts: InspectOptions = {}): Promise<InboundFlags> {
  const autoResponder = autoResponderReason(email);
  const loop = loopReason(email, opts.loop);
  const suppressedSender = opts.suppression ? await opts.suppression.isSuppressed(email.from.address) : false;
  return { autoResponder, loop, suppressedSender, flagged: autoResponder !== undefined || loop !== undefined || suppressedSender };
}
