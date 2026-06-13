import type { Address, Hex } from 'viem'

// --- Order state machine ---------------------------------------------------
//
//                          verify+settle ok
//  (request) -> PENDING_PAYMENT ----------> SETTLED -> MINTING -> COMPLETED
//                    |                          ^          |
//            verify/settle rejected             +--retry<--+ (attempts < MAX)
//                    |                                     |
//                    v                          attempts exhausted (= MAX)
//                  FAILED                                  v
//            (no funds moved)                         MINT_FAILED
//                                                         |
//                                                 refund  v
//                                           REFUNDING -> REFUNDED
//                                                 |
//                                      refund attempts exhausted
//                                                 v
//                                           REFUND_FAILED (operator alert)

export type OrderState =
  | 'PENDING_PAYMENT' // row created before settle; no funds captured
  | 'FAILED' // verify/settle rejected; terminal, nothing to compensate
  | 'SETTLED' // settle() ok, x402_tx recorded; awaiting mint
  | 'MINTING' // mint tx pinned/broadcast; awaiting receipt
  | 'COMPLETED' // mint_tx confirmed; terminal success
  | 'MINT_FAILED' // mint retries exhausted; funds captured but undelivered
  | 'REFUNDING' // refund tx broadcast; awaiting receipt
  | 'REFUNDED' // refund confirmed; terminal
  | 'REFUND_FAILED' // refund retries exhausted; terminal, needs operator

export const TERMINAL_STATES: readonly OrderState[] = [
  'FAILED',
  'COMPLETED',
  'REFUNDED',
  'REFUND_FAILED',
]

export function isTerminal(state: OrderState): boolean {
  return TERMINAL_STATES.includes(state)
}

export type RecipientKind = 'tba' | 'payer'

export interface Order {
  orderId: string // = EIP-3009 authorization nonce (0x…)
  authNonce: string // same nonce, also UNIQUE-constrained for replay safety
  state: OrderState
  payer: Address
  recipient: Address | null // resolved mint target (TBA or payer)
  recipientKind: RecipientKind | null
  itemId: string // bigint serialised as decimal string
  amount: string // USDC base units as decimal string
  x402Tx: Hex | null // settlement tx from the facilitator
  mintNonce: number | null // pinned wallet nonce for the mint tx (no double-mint)
  mintTx: Hex | null
  refundNonce: number | null // pinned wallet nonce for the refund tx (no double-refund)
  refundTx: Hex | null
  attempts: number // mint attempts made
  refundAttempts: number // refund attempts made
  nextRetryAt: number | null // epoch ms; null = not scheduled for a worker
  lastError: string | null
  createdAt: number // epoch ms
  updatedAt: number // epoch ms
}

// Fields supplied when an order is first created (PENDING_PAYMENT). Everything
// else defaults: state=PENDING_PAYMENT, attempts=0, timestamps=now, rest null.
export interface OrderSeed {
  orderId: string
  authNonce: string
  payer: Address
  itemId: string
  amount: string
}

// Patch shape for `update`. All optional; only provided keys are written.
export type OrderPatch = Partial<Omit<Order, 'orderId' | 'authNonce' | 'createdAt'>>

export interface OrderStore {
  /** Fetch an order by id (= auth nonce). Returns null if unknown. */
  get(orderId: string): Order | null
  /** Insert a new PENDING_PAYMENT order. Throws on duplicate orderId/nonce. */
  create(seed: OrderSeed): Order
  /** Apply a partial update; bumps updated_at. Returns the new row. */
  update(orderId: string, patch: OrderPatch): Order
  /**
   * Atomically select orders in `states` whose next_retry_at is due (<= now or
   * null) and immediately push their next_retry_at out (lease) so a concurrent
   * scheduler tick cannot claim the same row. Returns the claimed rows.
   */
  claimDueForRetry(now: number, states: OrderState[]): Order[]
  /** List orders in a given state (operator/admin visibility). */
  listByState(state: OrderState): Order[]
  close(): void
}
