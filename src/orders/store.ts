import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import type { Address, Hex } from 'viem'
import type { Order, OrderPatch, OrderSeed, OrderState, OrderStore } from './types.js'

// How long a claimed-for-retry row is leased before it can be re-claimed.
// The worker resets next_retry_at on completion or on its own backoff schedule,
// so this only matters if a worker dies mid-attempt — the row then becomes
// eligible again after the lease instead of being stuck forever.
const LEASE_MS = 60_000

// Raw row shape as stored in SQLite (snake_case, nullable columns).
interface OrderRow {
  order_id: string
  auth_nonce: string
  state: string
  payer: string
  recipient: string | null
  recipient_kind: string | null
  item_id: string
  amount: string
  x402_tx: string | null
  mint_nonce: number | null
  mint_tx: string | null
  refund_nonce: number | null
  refund_tx: string | null
  attempts: number
  refund_attempts: number
  next_retry_at: number | null
  last_error: string | null
  created_at: number
  updated_at: number
}

function rowToOrder(row: OrderRow): Order {
  return {
    orderId: row.order_id,
    authNonce: row.auth_nonce,
    state: row.state as OrderState,
    payer: row.payer as Address,
    recipient: (row.recipient as Address | null) ?? null,
    recipientKind: (row.recipient_kind as Order['recipientKind']) ?? null,
    itemId: row.item_id,
    amount: row.amount,
    x402Tx: (row.x402_tx as Hex | null) ?? null,
    mintNonce: row.mint_nonce,
    mintTx: (row.mint_tx as Hex | null) ?? null,
    refundNonce: row.refund_nonce,
    refundTx: (row.refund_tx as Hex | null) ?? null,
    attempts: row.attempts,
    refundAttempts: row.refund_attempts,
    nextRetryAt: row.next_retry_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// Maps camelCase Order keys to their SQLite columns for partial updates.
const COLUMN_OF: Record<keyof OrderPatch, string> = {
  state: 'state',
  payer: 'payer',
  recipient: 'recipient',
  recipientKind: 'recipient_kind',
  itemId: 'item_id',
  amount: 'amount',
  x402Tx: 'x402_tx',
  mintNonce: 'mint_nonce',
  mintTx: 'mint_tx',
  refundNonce: 'refund_nonce',
  refundTx: 'refund_tx',
  attempts: 'attempts',
  refundAttempts: 'refund_attempts',
  nextRetryAt: 'next_retry_at',
  lastError: 'last_error',
  updatedAt: 'updated_at',
}

export class SqliteOrderStore implements OrderStore {
  private readonly db: Database.Database

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    // WAL gives durable, atomic commits with better crash behaviour than the
    // default rollback journal — important for an order ledger.
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orders (
        order_id        TEXT PRIMARY KEY,
        auth_nonce      TEXT NOT NULL UNIQUE,
        state           TEXT NOT NULL,
        payer           TEXT NOT NULL,
        recipient       TEXT,
        recipient_kind  TEXT,
        item_id         TEXT NOT NULL,
        amount          TEXT NOT NULL,
        x402_tx         TEXT,
        mint_nonce      INTEGER,
        mint_tx         TEXT,
        refund_nonce    INTEGER,
        refund_tx       TEXT,
        attempts        INTEGER NOT NULL DEFAULT 0,
        refund_attempts INTEGER NOT NULL DEFAULT 0,
        next_retry_at   INTEGER,
        last_error      TEXT,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_orders_due ON orders(state, next_retry_at);
    `)
  }

  get(orderId: string): Order | null {
    const row = this.db
      .prepare('SELECT * FROM orders WHERE order_id = ?')
      .get(orderId) as OrderRow | undefined
    return row ? rowToOrder(row) : null
  }

  create(seed: OrderSeed): Order {
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO orders
           (order_id, auth_nonce, state, payer, item_id, amount, attempts,
            refund_attempts, created_at, updated_at)
         VALUES (?, ?, 'PENDING_PAYMENT', ?, ?, ?, 0, 0, ?, ?)`,
      )
      .run(seed.orderId, seed.authNonce, seed.payer, seed.itemId, seed.amount, now, now)
    const created = this.get(seed.orderId)
    if (!created) throw new Error(`order ${seed.orderId} vanished immediately after insert`)
    return created
  }

  update(orderId: string, patch: OrderPatch): Order {
    const keys = (Object.keys(patch) as Array<keyof OrderPatch>).filter(
      (k) => k !== 'updatedAt' && patch[k] !== undefined,
    )
    const assignments = keys.map((k) => `${COLUMN_OF[k]} = ?`)
    assignments.push('updated_at = ?')
    const values = keys.map((k) => patch[k] as unknown)
    values.push(Date.now())
    values.push(orderId)

    const info = this.db
      .prepare(`UPDATE orders SET ${assignments.join(', ')} WHERE order_id = ?`)
      .run(...(values as (string | number | null)[]))
    if (info.changes === 0) throw new Error(`order ${orderId} not found for update`)
    const updated = this.get(orderId)
    if (!updated) throw new Error(`order ${orderId} not found after update`)
    return updated
  }

  claimDueForRetry(now: number, states: OrderState[]): Order[] {
    if (states.length === 0) return []
    const placeholders = states.map(() => '?').join(', ')
    const claim = this.db.transaction((stateArgs: OrderState[]): Order[] => {
      const rows = this.db
        .prepare(
          `SELECT * FROM orders
             WHERE state IN (${placeholders})
               AND (next_retry_at IS NULL OR next_retry_at <= ?)
             ORDER BY next_retry_at ASC
             LIMIT 100`,
        )
        .all(...stateArgs, now) as OrderRow[]
      if (rows.length > 0) {
        const lease = now + LEASE_MS
        const update = this.db.prepare('UPDATE orders SET next_retry_at = ? WHERE order_id = ?')
        for (const row of rows) update.run(lease, row.order_id)
      }
      return rows.map(rowToOrder)
    })
    return claim(states)
  }

  listByState(state: OrderState): Order[] {
    const rows = this.db
      .prepare('SELECT * FROM orders WHERE state = ? ORDER BY updated_at DESC')
      .all(state) as OrderRow[]
    return rows.map(rowToOrder)
  }

  close(): void {
    this.db.close()
  }
}
