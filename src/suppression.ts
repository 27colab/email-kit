import { normalizeEmail } from './address.js';

export type SuppressionReason = 'unsubscribed' | 'bounced' | 'complaint' | 'manual';

export interface SuppressionList {
  isSuppressed(address: string): Promise<boolean> | boolean;
  add(address: string, reason: SuppressionReason): Promise<void> | void;
  remove(address: string): Promise<void> | void;
}

export class MemorySuppressionList implements SuppressionList {
  private readonly entries = new Map<string, SuppressionReason>();

  isSuppressed(address: string): boolean {
    return this.entries.has(normalizeEmail(address));
  }
  add(address: string, reason: SuppressionReason): void {
    this.entries.set(normalizeEmail(address), reason);
  }
  remove(address: string): void {
    this.entries.delete(normalizeEmail(address));
  }
  reasonFor(address: string): SuppressionReason | undefined {
    return this.entries.get(normalizeEmail(address));
  }
}

/**
 * RFC 2369 / RFC 8058 headers. `httpsUrl` should accept a POST from mail clients
 * (one-click) and add the address to your suppression list.
 */
export function unsubscribeHeaders(opts: { httpsUrl: string; mailto?: string }): Record<string, string> {
  const targets = [`<${opts.httpsUrl}>`];
  if (opts.mailto) targets.push(`<mailto:${opts.mailto}>`);
  return {
    'List-Unsubscribe': targets.join(', '),
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}
