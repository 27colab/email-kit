import { EmailSendError } from './types.js';

export interface RetryOptions {
  /** Total attempts including the first. Default 3. */
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** 0..1 fraction of random jitter. Default 0.2. */
  jitter?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Errors are retried only when they say so; unknown errors are treated as permanent. */
export function isRetryable(error: unknown): boolean {
  return error instanceof EmailSendError && error.retryable;
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const base = opts.baseDelayMs ?? 250;
  const max = opts.maxDelayMs ?? 5000;
  const jitter = opts.jitter ?? 0.2;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= attempts || !isRetryable(error)) throw error;
      const hinted = error instanceof EmailSendError ? error.retryAfterMs : undefined;
      const backoff = Math.min(max, base * 2 ** (attempt - 1));
      const delay = Math.min(max, hinted ?? backoff * (1 + jitter * random()));
      opts.onRetry?.(error, attempt, delay);
      await sleep(delay);
    }
  }
}
