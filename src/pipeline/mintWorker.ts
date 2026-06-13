import { retryPolicy } from '../config.js'
import {
  broadcastMint,
  getReceiptStatus,
  waitForMintReceipt,
  type MintReceipt,
} from '../chain/gamePayment.js'
import { errorMessage, log } from '../logger.js'
import type { Order, OrderPatch, OrderStore } from '../orders/types.js'
import { computeNextRetryAt } from './backoff.js'
import type { SerialQueue } from './mintQueue.js'

// How long to wait for a pending mint receipt during reconciliation before
// deferring the order to a later tick (so the serial queue is not blocked
// indefinitely by a stuck tx).
const RECEIPT_POLL_TIMEOUT_MS = 30_000

/**
 * Drives orders SETTLED -> MINTING -> COMPLETED, with bounded retries. On
 * exhaustion an order is moved to MINT_FAILED and scheduled immediately so the
 * refund pipeline (driven by the scheduler) can compensate the payer.
 *
 * Every mint runs through the shared SerialQueue keyed by orderId: one on-chain
 * write at a time (single nonce owner) and never the same order twice at once.
 */
export class MintWorker {
  constructor(
    private readonly store: OrderStore,
    private readonly queue: SerialQueue,
  ) {}

  /** Submit an order for minting (idempotent — dedupes an in-flight order). */
  enqueue(orderId: string): Promise<void> {
    return this.queue.submit(`mint:${orderId}`, () => this.run(orderId))
  }

  private async run(orderId: string): Promise<void> {
    let order = this.store.get(orderId)
    if (!order) return
    if (order.state !== 'SETTLED' && order.state !== 'MINTING') return
    if (!order.recipient) {
      this.markFailed(order, 'no mint recipient resolved')
      return
    }

    const recipient = order.recipient
    const fallback = { itemId: BigInt(order.itemId), paidAmount: BigInt(order.amount) }

    // 1. Reconcile any previously broadcast tx (pending tx / crash recovery).
    if (order.mintTx) {
      const status = await getReceiptStatus(order.mintTx)
      if (status === 'success') {
        this.complete(order)
        return
      }
      if (status === 'reverted') {
        order = this.store.update(orderId, {
          mintTx: null,
          mintNonce: null,
          lastError: 'mint reverted on-chain',
        })
        // fall through to a fresh attempt
      } else {
        // Not yet mined. Nudge by re-broadcasting on the SAME pinned nonce — a
        // duplicate cannot double-mint — then wait briefly for it to settle.
        if (order.mintNonce !== null) {
          try {
            await broadcastMint({
              to: recipient,
              itemId: fallback.itemId,
              paidAmount: fallback.paidAmount,
              maxPriceAllowed: fallback.paidAmount,
              nonce: order.mintNonce,
            })
          } catch {
            // "already known" / "nonce too low" — the original is in flight or mined.
          }
        }
        try {
          const r = await waitForMintReceipt(order.mintTx, fallback, RECEIPT_POLL_TIMEOUT_MS)
          if (r.status === 'success') {
            this.complete(order, r)
            return
          }
          order = this.store.update(orderId, {
            mintTx: null,
            mintNonce: null,
            lastError: 'mint reverted on-chain',
          })
        } catch {
          // Still pending — defer without consuming an attempt.
          this.store.update(orderId, {
            state: 'MINTING',
            nextRetryAt: computeNextRetryAt(Math.max(1, order.attempts)),
            lastError: 'mint tx still pending',
          })
          return
        }
      }
    }

    // 2. Fresh attempt.
    const attemptNo = order.attempts + 1
    if (attemptNo > retryPolicy.mintMaxAttempts) {
      this.markFailed(order, order.lastError ?? 'mint attempts exhausted')
      return
    }

    try {
      order = this.store.update(orderId, { state: 'MINTING', attempts: attemptNo })
      const broadcast = await broadcastMint({
        to: recipient,
        itemId: fallback.itemId,
        paidAmount: fallback.paidAmount,
        maxPriceAllowed: fallback.paidAmount,
        ...(order.mintNonce !== null ? { nonce: order.mintNonce } : {}),
      })
      // Persist tx + pinned nonce BEFORE awaiting the receipt: this bounds the
      // crash window to the few ms between broadcast and this write.
      order = this.store.update(orderId, {
        mintTx: broadcast.txHash,
        mintNonce: broadcast.nonce,
      })
      log.info('mint.broadcast', {
        orderId,
        txHash: broadcast.txHash,
        nonce: broadcast.nonce,
        attempt: attemptNo,
      })

      const receipt = await waitForMintReceipt(broadcast.txHash, fallback)
      if (receipt.status === 'success') {
        this.complete(order, receipt)
        return
      }
      throw new Error(`mint reverted (${receipt.txHash})`)
    } catch (err) {
      const msg = errorMessage(err)
      if (attemptNo >= retryPolicy.mintMaxAttempts) {
        this.store.update(orderId, {
          state: 'MINT_FAILED',
          mintTx: null,
          mintNonce: null,
          lastError: msg,
          nextRetryAt: Date.now(), // hand off to the refund pipeline now
        })
        log.error('mint.exhausted', { orderId, attempts: attemptNo, error: msg })
      } else {
        const nextRetryAt = computeNextRetryAt(attemptNo)
        this.store.update(orderId, {
          state: 'SETTLED',
          mintTx: null,
          mintNonce: null,
          lastError: msg,
          nextRetryAt,
        })
        log.warn('mint.retry_scheduled', { orderId, attempt: attemptNo, nextRetryAt, error: msg })
      }
    }
  }

  private complete(order: Order, receipt?: MintReceipt): void {
    const patch: OrderPatch = {
      state: 'COMPLETED',
      nextRetryAt: null,
      lastError: null,
    }
    if (receipt) {
      patch.mintTx = receipt.txHash
      patch.itemId = receipt.itemId
    }
    this.store.update(order.orderId, patch)
    log.info('mint.completed', {
      orderId: order.orderId,
      txHash: receipt?.txHash ?? order.mintTx,
      recipient: order.recipient,
    })
  }

  private markFailed(order: Order, reason: string): void {
    this.store.update(order.orderId, {
      state: 'MINT_FAILED',
      mintTx: null,
      mintNonce: null,
      lastError: reason,
      nextRetryAt: Date.now(),
    })
    log.error('mint.failed', { orderId: order.orderId, error: reason })
  }
}
