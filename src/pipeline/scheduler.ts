import { retryPolicy } from '../config.js'
import { log } from '../logger.js'
import type { Order, OrderState, OrderStore } from '../orders/types.js'
import type { MintWorker } from './mintWorker.js'
import type { RefundWorker } from './refundWorker.js'

// States the background scheduler actively drives. PENDING_PAYMENT is excluded
// on purpose: no funds have moved and we don't persist the signed payload, so
// recovery there is client-driven (the buyer retries the same nonce and the
// HTTP idempotency path resumes it). FAILED/COMPLETED/REFUNDED/REFUND_FAILED
// are terminal.
const MINT_STATES: OrderState[] = ['SETTLED', 'MINTING']
const REFUND_STATES: OrderState[] = ['MINT_FAILED', 'REFUNDING']
const ACTIVE_STATES: OrderState[] = [...MINT_STATES, ...REFUND_STATES]

/**
 * Periodically claims due orders and routes them to the mint or refund worker.
 * Also reconciles all in-flight orders once at boot so a crash mid-mint/refund
 * is recovered on the next start.
 */
export class RetryScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false

  constructor(
    private readonly store: OrderStore,
    private readonly mintWorker: MintWorker,
    private readonly refundWorker: RefundWorker,
  ) {}

  /** Recover in-flight orders left behind by a previous run. */
  reconcileOnBoot(): void {
    const pending = ACTIVE_STATES.flatMap((s) => this.store.listByState(s))
    if (pending.length === 0) {
      log.info('scheduler.reconcile', { recovered: 0 })
      return
    }
    log.warn('scheduler.reconcile', {
      recovered: pending.length,
      detail: pending.map((o) => `${o.orderId.slice(0, 10)}=${o.state}`),
    })
    for (const order of pending) this.dispatch(order)
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), retryPolicy.tickMs)
    // setInterval keeps the event loop alive; that's fine for a long-running
    // server, but unref so the process can still exit cleanly on shutdown.
    this.timer.unref?.()
    log.info('scheduler.started', { tickMs: retryPolicy.tickMs })
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async tick(): Promise<void> {
    if (this.ticking) return // never overlap ticks
    this.ticking = true
    try {
      const due = this.store.claimDueForRetry(Date.now(), ACTIVE_STATES)
      for (const order of due) this.dispatch(order)
    } catch (err) {
      log.error('scheduler.tick_error', { error: err instanceof Error ? err.message : String(err) })
    } finally {
      this.ticking = false
    }
  }

  private dispatch(order: Order): void {
    if (MINT_STATES.includes(order.state)) {
      void this.mintWorker.enqueue(order.orderId)
    } else if (REFUND_STATES.includes(order.state)) {
      void this.refundWorker.enqueue(order.orderId)
    }
  }
}
