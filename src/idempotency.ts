import { createHash } from 'node:crypto';
import type { EmailMessage, SendResult } from './types.js';

export interface IdempotencyStore {
  get(key: string): Promise<SendResult | undefined> | SendResult | undefined;
  set(key: string, result: SendResult): Promise<void> | void;
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly map = new Map<string, SendResult>();
  get(key: string): SendResult | undefined {
    return this.map.get(key);
  }
  set(key: string, result: SendResult): void {
    this.map.set(key, result);
  }
}

/**
 * Content-derived key: same recipient + subject + body (+ optional scope) gives the
 * same key. Pass `scope` (e.g. an order id) when identical content may be sent
 * legitimately more than once.
 */
export function deriveIdempotencyKey(message: EmailMessage, scope = ''): string {
  const h = createHash('sha256');
  h.update(JSON.stringify([scope, message.to.trim().toLowerCase(), message.subject, message.text ?? '', message.html ?? '']));
  return `ek_${h.digest('hex').slice(0, 32)}`;
}
