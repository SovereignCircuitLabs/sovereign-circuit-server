import express from 'express'
import { getAddress, type Address } from 'viem'
import {
  adminToken,
  chainConfig,
  facilitator,
  gamePaymentAddress,
  network,
  NPC_TBA_HEADER,
  NPC_TOKEN_ID_HEADER,
  orderDbPath,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  serverAccount,
  tbaValidationEnabled,
} from './config.js'
import { loadManagedItemIds, quoteBuyPrice } from './chain/gamePayment.js'
import { resolveMintRecipient } from './chain/tba.js'
import { errorMessage, log } from './logger.js'
import { decodePaymentHeader, deriveIdentity } from './payments/idempotency.js'
import { contractRoutes } from './routes/contractRoutes.js'
import { ContractServiceError } from './services/contractErrors.js'
import { SqliteOrderStore } from './orders/store.js'
import type { Order, OrderState } from './orders/types.js'
import { SerialQueue } from './pipeline/mintQueue.js'
import { MintWorker } from './pipeline/mintWorker.js'
import { RefundWorker } from './pipeline/refundWorker.js'
import { RetryScheduler } from './pipeline/scheduler.js'

// --- Composition root ------------------------------------------------------

const store = new SqliteOrderStore(orderDbPath)
const queue = new SerialQueue()
const mintWorker = new MintWorker(store, queue)
const refundWorker = new RefundWorker(store, queue)
const scheduler = new RetryScheduler(store, mintWorker, refundWorker)

// Max time the request handler blocks on the first inline mint attempt before
// handing the order off to the background worker and replying with MINTING.
const INLINE_MINT_TIMEOUT_MS = 8000

const app = express()
app.use(express.json({ limit: '64kb' }))

// Browser clients see custom response headers only if explicitly exposed.
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, PAYMENT-SIGNATURE, X-NPC-TBA, X-NPC-TOKEN-ID')
  res.setHeader(
    'Access-Control-Expose-Headers',
    [PAYMENT_REQUIRED_HEADER, PAYMENT_RESPONSE_HEADER].join(', '),
  )
  if (_req.method === 'OPTIONS') {
    res.status(204).end()
    return
  }
  next()
})

let managedItemIds: readonly bigint[] = []

async function createPaymentRequirements(amountUsdcBaseUnits: bigint) {
  const supported = await facilitator.getSupported()
  const supportedKind = supported.kinds.find((kind) => kind.network === network)
  const verifyingContract = supportedKind?.extra?.verifyingContract
  if (typeof verifyingContract !== 'string') {
    throw new Error(`Circle Gateway does not support ${network}`)
  }
  return {
    scheme: 'exact',
    network,
    asset: chainConfig.usdc,
    amount: amountUsdcBaseUnits.toString(),
    payTo: gamePaymentAddress,
    maxTimeoutSeconds: 604900,
    chainId: chainConfig.chain.id,
    extra: {
      name: 'GatewayWalletBatched',
      version: '1',
      verifyingContract,
      chainId: chainConfig.chain.id,
    },
  }
}

// Public JSON shape for an order (used by /item, /order, /admin responses).
function orderView(order: Order) {
  return {
    order_id: order.orderId,
    state: order.state,
    payer: order.payer,
    item_id: order.itemId,
    amount: order.amount,
    x402_tx: order.x402Tx,
    recipient: order.recipient,
    recipient_kind: order.recipientKind,
    attempts: order.attempts,
    refund_attempts: order.refundAttempts,
    mint: order.mintTx
      ? { tx_hash: order.mintTx, recipient: order.recipient, recipient_kind: order.recipientKind }
      : null,
    refund: order.refundTx ? { tx_hash: order.refundTx } : null,
    error: order.lastError,
    updated_at: order.updatedAt,
  }
}

function setSettlementHeader(res: express.Response, order: Order) {
  res.setHeader(
    PAYMENT_RESPONSE_HEADER,
    Buffer.from(
      JSON.stringify({
        success: true,
        transaction: order.x402Tx,
        network,
        payer: order.payer,
        order_id: order.orderId,
      }),
    ).toString('base64'),
  )
}

// Block briefly on the first mint so a healthy purchase returns COMPLETED
// inline; otherwise the background scheduler carries it to completion.
async function awaitMintBriefly(orderId: string): Promise<void> {
  await Promise.race([
    mintWorker.enqueue(orderId),
    new Promise<void>((resolve) => setTimeout(resolve, INLINE_MINT_TIMEOUT_MS)),
  ])
}

app.get('/item/:id', async (req, res, next) => {
  try {
    const idParam = req.params.id
    if (!/^\d+$/.test(idParam)) {
      res.status(400).json({ error: `Invalid item id: ${idParam}` })
      return
    }
    const itemId = BigInt(idParam)
    if (!managedItemIds.some((known) => known === itemId)) {
      res.status(404).json({
        error: `Unknown item id ${itemId.toString()}`,
        managed_ids: managedItemIds.map((x) => x.toString()),
      })
      return
    }

    const quotedPrice = await quoteBuyPrice(itemId)
    const requirements = await createPaymentRequirements(quotedPrice)

    // --- Step 1: unpaid request -> 402 challenge ---------------------------
    const paymentHeader = req.headers[PAYMENT_SIGNATURE_HEADER.toLowerCase()]
    if (!paymentHeader) {
      const paymentRequired = {
        x402Version: 2,
        resource: {
          url: req.originalUrl,
          description: `GameItem #${itemId.toString()}`,
          mimeType: 'application/json',
        },
        accepts: [requirements],
      }
      log.info('payment.challenge', {
        method: req.method,
        url: req.originalUrl,
        price: quotedPrice.toString(),
      })
      res.status(402)
      res.setHeader(
        PAYMENT_REQUIRED_HEADER,
        Buffer.from(JSON.stringify(paymentRequired)).toString('base64'),
      )
      res.json({})
      return
    }

    // --- Step 2: decode payload + derive idempotency key -------------------
    let paymentPayload: ReturnType<typeof decodePaymentHeader>
    let identity: ReturnType<typeof deriveIdentity>
    try {
      paymentPayload = decodePaymentHeader(String(paymentHeader))
      identity = deriveIdentity(paymentPayload)
    } catch (err) {
      log.warn('payment.malformed', { error: errorMessage(err) })
      res.status(402).json({ error: 'Malformed PAYMENT-SIGNATURE header', reason: errorMessage(err) })
      return
    }
    const { orderId, authNonce, payer } = identity

    // --- Step 3: idempotency lookup ----------------------------------------
    const existing = store.get(orderId)
    if (existing && existing.state !== 'PENDING_PAYMENT') {
      // Already past settlement (or terminal). Never re-settle; just report
      // state and make sure the relevant pipeline is running.
      if (existing.state === 'SETTLED' || existing.state === 'MINTING') {
        void mintWorker.enqueue(orderId)
      } else if (existing.state === 'MINT_FAILED' || existing.state === 'REFUNDING') {
        void refundWorker.enqueue(orderId)
      }
      log.info('order.replay', { orderId, state: existing.state })
      if (existing.x402Tx) setSettlementHeader(res, existing)
      res.status(existing.state === 'FAILED' ? 402 : 200)
      res.json(orderView(existing))
      return
    }

    // New order, or resuming a PENDING_PAYMENT row left by a prior crash.
    const isResume = existing !== null
    if (!isResume) {
      store.create({ orderId, authNonce, payer, itemId: itemId.toString(), amount: quotedPrice.toString() })
    }

    const enrichedPayload = {
      ...paymentPayload,
      resource: {
        url: req.originalUrl,
        description: `GameItem #${itemId.toString()}`,
        mimeType: 'application/json',
      },
      accepted: requirements,
    }

    // --- Step 4: verify ----------------------------------------------------
    log.info('payment.verify', { orderId, payer, itemId: itemId.toString() })
    const verifyResult = await facilitator.verify(enrichedPayload as never, requirements)
    if (!verifyResult.isValid) {
      store.update(orderId, { state: 'FAILED', lastError: `verify: ${verifyResult.invalidReason}` })
      log.warn('payment.verify_rejected', { orderId, reason: verifyResult.invalidReason })
      res.status(402).json({ error: 'Payment verification failed', reason: verifyResult.invalidReason })
      return
    }

    // --- Step 5: resolve recipient BEFORE settling -------------------------
    // We must not capture funds we cannot deliver, so TBA validation happens
    // before settle. A bad TBA header fails here with no money taken.
    let recipient: { recipient: Address; kind: 'tba' | 'payer' }
    try {
      recipient = await resolveMintRecipient({
        payer: (verifyResult.payer as Address) ?? payer,
        tbaHeader: req.headers[NPC_TBA_HEADER.toLowerCase()] as string | undefined,
        tokenIdHeader: req.headers[NPC_TOKEN_ID_HEADER.toLowerCase()] as string | undefined,
      })
    } catch (err) {
      const reason = errorMessage(err)
      store.update(orderId, { state: 'FAILED', lastError: `recipient: ${reason}` })
      log.warn('payment.recipient_rejected', { orderId, error: reason })
      res.status(402).json({ error: 'Recipient validation failed; refusing to settle', reason })
      return
    }

    // --- Step 6: settle ----------------------------------------------------
    const settleResult = await facilitator.settle(enrichedPayload as never, requirements)
    if (!settleResult.success) {
      // Edge case: if this is a resumed order and the failure is "nonce already
      // used", a prior attempt likely settled before crashing. We cannot
      // recover the tx hash here, so we surface it loudly for an operator.
      const reason = settleResult.errorReason ?? 'unknown'
      const nonceUsed = isResume && /nonce/i.test(reason) && /used|already/i.test(reason)
      store.update(orderId, { state: 'FAILED', lastError: `settle: ${reason}` })
      log[nonceUsed ? 'error' : 'warn']('payment.settle_rejected', {
        orderId,
        reason,
        ...(nonceUsed ? { alert: 'possible orphaned settlement — verify on-chain' } : {}),
      })
      res.status(402).json({ error: 'Payment settlement failed', reason })
      return
    }

    const settledPayer = (settleResult.payer ?? verifyResult.payer ?? payer) as Address
    const order = store.update(orderId, {
      state: 'SETTLED',
      payer: settledPayer,
      x402Tx: settleResult.transaction as `0x${string}`,
      recipient: getAddress(recipient.recipient),
      recipientKind: recipient.kind,
      nextRetryAt: Date.now(),
      lastError: null,
    })
    log.info('payment.settled', { orderId, x402Tx: settleResult.transaction, payer: settledPayer })
    setSettlementHeader(res, order)

    // --- Step 7: mint (inline first attempt, background retries) -----------
    await awaitMintBriefly(orderId)
    const finalOrder = store.get(orderId) ?? order
    res.status(200).json(orderView(finalOrder))
  } catch (error) {
    next(error)
  }
})

// Order status — clients poll this until COMPLETED / REFUNDED / *_FAILED.
app.get('/order/:orderId', (req, res) => {
  const order = store.get(req.params.orderId.toLowerCase())
  if (!order) {
    res.status(404).json({ error: `Unknown order ${req.params.orderId}` })
    return
  }
  res.json(orderView(order))
})

// Operator visibility into stuck orders. Disabled unless ADMIN_TOKEN is set.
app.get('/admin/orders', (req, res) => {
  if (!adminToken) {
    res.status(404).json({ error: 'admin endpoint disabled (set ADMIN_TOKEN)' })
    return
  }
  if (req.headers.authorization !== `Bearer ${adminToken}`) {
    res.status(401).json({ error: 'unauthorized' })
    return
  }
  const KNOWN: OrderState[] = [
    'PENDING_PAYMENT', 'FAILED', 'SETTLED', 'MINTING', 'COMPLETED',
    'MINT_FAILED', 'REFUNDING', 'REFUNDED', 'REFUND_FAILED',
  ]
  const state = (req.query.state as string | undefined) ?? 'REFUND_FAILED'
  if (!KNOWN.includes(state as OrderState)) {
    res.status(400).json({ error: `Unknown state ${state}`, known: KNOWN })
    return
  }
  res.json(store.listByState(state as OrderState).map(orderView))
})

app.use('/api', contractRoutes)

// Express 5 error handler.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const reason = errorMessage(err)
  const status = err instanceof ContractServiceError
    ? 502
    : /is not configured/.test(reason)
      ? 503
      : /must be|Invalid|Bad /.test(reason)
        ? 400
        : 500
  log.error('http.unhandled', { status, error: reason })
  if (!res.headersSent) res.status(status).json({ error: 'request failed', reason })
})

// --- Boot ------------------------------------------------------------------

managedItemIds = await loadManagedItemIds()
log.info('boot.items_loaded', { count: managedItemIds.length, ids: managedItemIds.map((x) => x.toString()) })

scheduler.reconcileOnBoot()
scheduler.start()

const server = app.listen(4021, () => {
  log.info('boot.listening', {
    url: 'http://localhost:4021',
    gamePayment: gamePaymentAddress,
    minter: serverAccount.address,
    tbaRouting: tbaValidationEnabled,
    dbPath: orderDbPath,
  })
})

function shutdown(signal: string) {
  log.info('boot.shutdown', { signal, inFlight: queue.size })
  scheduler.stop()
  server.close(() => {
    store.close()
    process.exit(0)
  })
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
