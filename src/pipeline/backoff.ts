import { retryPolicy } from '../config.js'

/**
 * Exponential backoff with full jitter:
 *   delay = min(base * 2^attempt, cap) +/- jitter
 * Returns an absolute epoch-ms timestamp for `next_retry_at`.
 */
export function computeNextRetryAt(attempt: number, now = Date.now()): number {
  const exp = retryPolicy.baseMs * 2 ** Math.max(0, attempt - 1)
  const capped = Math.min(exp, retryPolicy.capMs)
  const jitter = capped * 0.2 * (Math.random() - 0.5) // +/-10%
  return now + Math.round(capped + jitter)
}
