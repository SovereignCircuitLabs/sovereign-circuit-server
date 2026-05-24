import 'dotenv/config'
import express from 'express'
import { CHAIN_CONFIGS } from '@circle-fin/x402-batching/client'
import { BatchFacilitatorClient } from '@circle-fin/x402-batching/server'

const serverAddress = process.env.SERVER_ADDRESS as string
if (!serverAddress) {
  console.error('SERVER_ADDRESS not set in .env')
  process.exit(1)
}

const app = express()
const chainConfig = CHAIN_CONFIGS.arcTestnet
// arcTestnet lives behind the testnet Gateway; the default URL is mainnet.
const facilitator = new BatchFacilitatorClient({
  url: process.env.GATEWAY_URL ?? 'https://gateway-api-testnet.circle.com',
})
const network = `eip155:${chainConfig.chain.id}`
// Circle Gateway requires the authorization value to equal this amount exactly.
const requiredPrice = '$0.10'

const PAYMENT_REQUIRED_HEADER = 'PAYMENT-REQUIRED'
const PAYMENT_SIGNATURE_HEADER = 'PAYMENT-SIGNATURE'
const PAYMENT_RESPONSE_HEADER = 'PAYMENT-RESPONSE'

// Browser clients see custom response headers only if they're explicitly exposed.
// Unity's UnityWebRequest doesn't need this, but it lets the same endpoint be
// driven from a browser-side tester without surprises.
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader(
    'Access-Control-Expose-Headers',
    [PAYMENT_REQUIRED_HEADER, PAYMENT_RESPONSE_HEADER].join(', '),
  )
  next()
})

function parsePrice(value: string) {
  const amount = Number.parseFloat(value.replace('$', ''))
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`Invalid price: ${value}`)
  }

  return Math.round(amount * 1_000_000).toString()
}

async function createPaymentRequirements() {
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
    amount: parsePrice(requiredPrice),
    payTo: serverAddress,
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

function decodePaymentHeader(value: string) {
  // Unity ships PAYMENT-SIGNATURE as Base64(JSON). Be lenient and also accept
  // raw JSON for hand-rolled curl-style debugging.
  const buf = Buffer.from(value, 'base64')
  const candidate = buf.toString('utf-8')
  try {
    return JSON.parse(candidate)
  } catch {
    return JSON.parse(value)
  }
}

app.get('/risk-profile', async (req, res, next) => {
  try {
    const requirements = await createPaymentRequirements()
    // Node lower-cases all incoming header keys, so look up with the lower-case
    // form even though we emit the canonical PAYMENT-SIGNATURE name in clients.
    const paymentHeader = req.headers[PAYMENT_SIGNATURE_HEADER.toLowerCase()]

    if (!paymentHeader) {
      const paymentRequired = {
        x402Version: 2,
        resource: {
          url: req.originalUrl,
          description: 'Risk profile',
          mimeType: 'application/json',
        },
        accepts: [requirements],
      }

      console.log(`[402] ${req.method} ${req.originalUrl} -> ${requiredPrice}`)

      res.status(402)
      res.setHeader(
        PAYMENT_REQUIRED_HEADER,
        Buffer.from(JSON.stringify(paymentRequired)).toString('base64'),
      )
      res.json({})
      return
    }

    let paymentPayload: Record<string, unknown>
    try {
      paymentPayload = decodePaymentHeader(String(paymentHeader))
    } catch (err) {
      console.warn('[402] malformed PAYMENT-SIGNATURE header', err)
      res.status(402).json({ error: 'Malformed PAYMENT-SIGNATURE header' })
      return
    }

    const payerHint =
      (paymentPayload.payload as { authorization?: { from?: string } } | undefined)?.authorization
        ?.from ?? 'unknown'
    console.log(`[pay] verifying authorization from ${payerHint}`)

    // Circle Gateway's /v1/x402/verify requires `resource` and `accepted` on the
    // payment payload. 
    // The Circle TS client adds them on the buyer side; 
    // Unity doesn't, so we re-attach them here from the requirements we already sent.
    const enrichedPayload = {
      ...paymentPayload,
      resource: {
        url: req.originalUrl,
        description: 'Risk profile',
        mimeType: 'application/json',
      },
      accepted: requirements,
    }

    const verifyResult = await facilitator.verify(enrichedPayload as never, requirements)
    if (!verifyResult.isValid) {
      console.warn(`[pay] verify rejected: ${verifyResult.invalidReason}`)
      res.status(402).json({
        error: 'Payment verification failed',
        reason: verifyResult.invalidReason,
      })
      return
    }

    const settleResult = await facilitator.settle(enrichedPayload as never, requirements)
    if (!settleResult.success) {
      console.warn(`[pay] settle rejected: ${settleResult.errorReason}`)
      res.status(402).json({
        error: 'Payment settlement failed',
        reason: settleResult.errorReason,
      })
      return
    }

    console.log(
      `[pay] settled tx=${settleResult.transaction} payer=${settleResult.payer ?? verifyResult.payer}`,
    )

    res.setHeader(
      PAYMENT_RESPONSE_HEADER,
      Buffer.from(
        JSON.stringify({
          success: true,
          transaction: settleResult.transaction,
          network: requirements.network,
          payer: settleResult.payer ?? verifyResult.payer,
        }),
      ).toString('base64'),
    )

    res.json({
      x402_tx: settleResult.transaction,
      payer: settleResult.payer ?? verifyResult.payer,
      payTo: requirements.payTo,
      amount: requirements.amount,
      risk_score: 87,
      risk_level: 'high',
      recommendation: 'block_transaction'
    })
  } catch (error) {
    next(error)
  }
})

app.listen(4021, () => {
  console.log('Server on http://localhost:4021')
  console.log(`Paywall: GET /risk-profile -> USDC nanopayment (Circle Gateway)`)
  console.log(`Seller address: ${serverAddress}`)
})
