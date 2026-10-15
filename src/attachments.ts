import type { Attachment } from './types.js';

export interface BatchOptions {
  /** Max combined size of one batch. Default 15 MB (leaves headroom under common 20-40 MB caps after base64). */
  maxBytes?: number;
  /** Max attachments per batch. Default 10. */
  maxCount?: number;
}

export interface AttachmentBatches {
  batches: Attachment[][];
  /** Attachments larger than maxBytes on their own; never silently dropped. */
  oversized: Attachment[];
}

export function attachmentSize(a: Attachment): number {
  // base64 strings decode to ~3/4 of their length
  if (typeof a.content !== 'string') return a.content.byteLength;
  const padding = a.content.endsWith('==') ? 2 : a.content.endsWith('=') ? 1 : 0;
  return Math.floor((a.content.length * 3) / 4) - padding;
}

/** Greedy in-order packing. Order is preserved so "part 1 of N" stays meaningful. */
export function batchAttachments(attachments: Attachment[], opts: BatchOptions = {}): AttachmentBatches {
  const maxBytes = opts.maxBytes ?? 15 * 1024 * 1024;
  const maxCount = opts.maxCount ?? 10;
  const batches: Attachment[][] = [];
  const oversized: Attachment[] = [];
  let current: Attachment[] = [];
  let currentBytes = 0;

  for (const a of attachments) {
    const size = attachmentSize(a);
    if (size > maxBytes) {
      oversized.push(a);
      continue;
    }
    if (current.length > 0 && (current.length >= maxCount || currentBytes + size > maxBytes)) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(a);
    currentBytes += size;
  }
  if (current.length) batches.push(current);
  return { batches, oversized };
}
