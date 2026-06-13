import { retryPolicy } from '../config.js'
import { broadcastRefund, getReceiptStatus, waitForReceiptStatus } from '../chain/gamePayment.js'
import { errorMessage, log } from '../logger.js'
import type { Order, OrderStore } from '../orders/types.js'
import { computeNextRetryAt } from './backoff.js'
import type { SerialQueue } from './mintQueue.js'

const RECEIPT_POLL_TIMEOUT_MS = 30_000

/**
 * Compensation pipeline: drives MINT_FAILED -> REFUNDING -> REFUNDED. On
 * exhaustion the order is parked in REFUND_FAILED for an operator (surfaced via
 * GET /admin/orders). Shares the SerialQueue with the mint worker so refunds
 * and mints never contend for the wallet nonce.
 */
export class RefundWorker {
  constructor(
    private readonly store: OrderStore,
    private readonly queue: SerialQueue,
  ) {}

  enqueue(orderId: string): Promise<void> {
    return this.queue.submit(`refund:${orderId}`, () => this.run(orderId))
  }

  private async run(orderId: string): Promise<void> {
    let order = this.store.get(orderId)
    if (!order) return
    if (order.state !== 'MINT_FAILED' && order.state !== 'REFUNDING') return

    const amount = BigInt(order.amount)

    // 1. Reconcile any previously broadcast refund tx.
    if (order.refundTx) {
      const status = await getReceiptStatus(order.refundTx)
      if (status === 'success') {
        this.complete(order)
        return
      }
      if (status === 'reverted') {
        order = this.store.update(orderId, {
          refundTx: null,
          refundNonce: null,
          lastError: 'refund reverted on-chain',
        })
      } else {
        if (order.refundNonce !== null) {
          try {
            await broadcastRefund({ to: order.payer, amount, nonce: order.refundNonce })
          } catch {
            // already known / nonce too low
          }
        }
        try {
          const result = await waitForReceiptStatus(order.refundTx, RECEIPT_POLL_TIMEOUT_MS)
          if (result === 'success') {
            this.complete(order)
            return
          }
          order = this.store.update(orderId, {
            refundTx: null,
            refundNonce: null,
            lastError: 'refund reverted on-chain',
          })
        } catch {
          this.store.update(orderId, {
            state: 'REFUNDING',
            nextRetryAt: computeNextRetryAt(Math.max(1, order.refundAttempts)),
            lastError: 'refund tx still pending',
          })
          return
        }
      }
    }

    // 2. Fresh refund attempt.
    const attemptNo = order.refundAttempts + 1
    if (attemptNo > retryPolicy.refundMaxAttempts) {
      this.markFailed(order, order.lastError ?? 'refund attempts exhausted')
      return
    }

    try {
      order = this.store.update(orderId, { state: 'REFUNDING', refundAttempts: attemptNo })
      const broadcast = await broadcastRefund({
        to: order.payer,
        amount,
        ...(order.refundNonce !== null ? { nonce: order.refundNonce } : {}),
      })
      order = this.store.update(orderId, {
        refundTx: broadcast.txHash,
        refundNonce: broadcast.nonce,
      })
      log.info('refund.broadcast', {
        orderId,
        txHash: broadcast.txHash,
        nonce: broadcast.nonce,
        attempt: attemptNo,
      })

      const result = await waitForReceiptStatus(broadcast.txHash)
      if (result === 'success') {
        this.complete(order)
        return
      }
      throw new Error(`refund reverted (${broadcast.txHash})`)
    } catch (err) {
      const msg = errorMessage(err)
      if (attemptNo >= retryPolicy.refundMaxAttempts) {
        this.markFailed(order, msg)
      } else {
        const nextRetryAt = computeNextRetryAt(attemptNo)
        this.store.update(orderId, {
          state: 'MINT_FAILED',
          refundTx: null,
          refundNonce: null,
          lastError: msg,
          nextRetryAt,
        })
        log.warn('refund.retry_scheduled', { orderId, attempt: attemptNo, nextRetryAt, error: msg })
      }
    }
  }

  private complete(order: Order): void {
    this.store.update(order.orderId, {
      state: 'REFUNDED',
      nextRetryAt: null,
      lastError: null,
    })
    log.info('refund.completed', {
      orderId: order.orderId,
      txHash: order.refundTx,
      payer: order.payer,
      amount: order.amount,
    })
  }

  private markFailed(order: Order, reason: string): void {
    this.store.update(order.orderId, {
      state: 'REFUND_FAILED',
      lastError: reason,
      nextRetryAt: null,
    })
    log.error('refund.exhausted', {
      orderId: order.orderId,
      payer: order.payer,
      amount: order.amount,
      error: reason,
      alert: 'manual payout required',
    })
  }
}
