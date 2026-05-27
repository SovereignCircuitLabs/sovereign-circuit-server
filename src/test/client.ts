import 'dotenv/config'
import { randomBytes } from 'node:crypto'
import { privateKeyToAccount } from 'viem/accounts'
import type { Address, Hex } from 'viem'
import { GatewayClient } from '@circle-fin/x402-batching/client'

// TypeScript mirror of ArcNanopaymentClient.cs (Unity buyer/client).
// Reproduces the exact 1:1 HTTP / EIP-712 flow Unity performs, so the server
// can be debugged end-to-end without running Unity.
//
// NOTE: Unity defaults `authorizationTtlSeconds` to 120s. Circle Gateway
// requires the EIP-3009 authorization to remain valid for at least 7 days +
// 100s (`GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS`), so verify() is expected to
// reject this payload. We deliberately keep 120s here to mirror Unity
// faithfully — flip AUTH_TTL_SECONDS to 7*86400 + 100 to get a payload that
// Circle will actually accept.

const privateKey = process.env.CLIENT_PRIVATE_KEY as Hex | undefined
if (!privateKey) {
  console.error('CLIENT_PRIVATE_KEY not set')
  process.exit(1)
}

const URL_ = process.env.X402_URL ?? 'http://localhost:4021/risk-profile'
const PAYMENT_AMOUNT = 10_000_0n // 0.1 USDC (6 decimals), matches Unity test ParseUsdc(0.1m)
const AUTH_TTL_SECONDS = 604900 // 7 * 86400 + 100 => Circle Gateway requires at least 7 days + 100s validity for EIP-3009 authorizations
const FALLBACK_CHAIN_ID = 5042002

const PAYMENT_REQUIRED_HEADER = 'PAYMENT-REQUIRED'
const PAYMENT_SIGNATURE_HEADER = 'PAYMENT-SIGNATURE'
const PAYMENT_RESPONSE_HEADER = 'PAYMENT-RESPONSE'

interface PaywallSpec {
  scheme?: string
  network?: string
  asset?: string
  payTo?: string
  amount?: string
  maxAmountRequired?: string
  value?: string
  chainId?: number
  verifyingContract?: string
  extra?: {
    name?: string
    version?: string
    verifyingContract?: string
    chainId?: number
  }
}

function firstNonEmpty(...candidates: Array<string | undefined>): string | undefined {
  for (const c of candidates) if (c) return c
  return undefined
}

function decodePaymentRequirements(headerValue: string): PaywallSpec {
  let json: string
  try {
    json = Buffer.from(headerValue, 'base64').toString('utf-8')
  } catch {
    json = headerValue
  }
  const parsed = JSON.parse(json) as { accepts?: PaywallSpec[] } & PaywallSpec
  if (Array.isArray(parsed.accepts) && parsed.accepts.length > 0) {
    return parsed.accepts[0] as PaywallSpec
  }
  return parsed
}

function validateSettlement(headerValue: string) {
  let json: string
  try {
    json = Buffer.from(headerValue, 'base64').toString('utf-8')
  } catch {
    json = headerValue
  }
  let settlement: Record<string, unknown>
  try {
    settlement = JSON.parse(json)
  } catch {
    return
  }
  const success = (settlement.success ?? settlement.settled ?? true) as boolean
  if (!success) {
    throw new Error(`Circle settlement rejected: ${json}`)
  }
  console.log('[client] settlement:', settlement)
}

async function generateEip3009Signature(
  account: ReturnType<typeof privateKeyToAccount>,
  spec: PaywallSpec,
  paymentAmount: bigint,
) {
  const extra = spec.extra ?? {}

  const verifyingContract = firstNonEmpty(spec.verifyingContract, extra.verifyingContract, spec.asset)
  if (!verifyingContract) throw new Error('verifyingContract missing in payment requirements.')

  const payTo = spec.payTo
  if (!payTo) throw new Error('payTo missing in payment requirements.')

  const requiredStr = firstNonEmpty(spec.amount, spec.maxAmountRequired, spec.value)
  if (requiredStr) {
    const required = BigInt(requiredStr)
    if (paymentAmount < required) {
      throw new Error(`Payment amount ${paymentAmount} is below server-required ${required}.`)
    }
  }

  const chainId = spec.chainId ?? extra.chainId ?? FALLBACK_CHAIN_ID
  const from = account.address

  const nowSeconds = Math.floor(Date.now() / 1000)
  const validAfter = 0n
  const validBefore = BigInt(nowSeconds + AUTH_TTL_SECONDS)

  // EIP-3009 requires a 32-byte cryptographically secure random nonce.
  const nonceBytes = randomBytes(32)
  const nonceHex = `0x${nonceBytes.toString('hex')}` as Hex

  const signature = await account.signTypedData({
    domain: {
      name: extra.name ?? 'GatewayWalletBatched',
      version: extra.version ?? '1',
      chainId,
      verifyingContract: verifyingContract as Address,
    },
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization',
    message: {
      from,
      to: payTo as Address,
      value: paymentAmount,
      validAfter,
      validBefore,
      nonce: nonceHex,
    },
  })

  // Exact field order Unity emits, with payment value/timestamps stringified.
  return {
    x402Version: 2,
    scheme: spec.scheme ?? 'exact',
    network: spec.network ?? 'arc-testnet',
    payload: {
      signature,
      authorization: {
        from,
        to: payTo,
        value: paymentAmount.toString(),
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce: nonceHex,
      },
    },
  }
}

async function fetchPaywalledResource(url: string, pk: Hex, paymentAmount: bigint) {
  // Step 1 — initial probe; expect 402 with PAYMENT-REQUIRED header.
  const probe = await fetch(url, { method: 'GET' })
  if (probe.status === 200) return await probe.text()
  if (probe.status !== 402) {
    throw new Error(`[client] Unexpected status ${probe.status} on probe: ${await probe.text()}`)
  }

  const paymentRequiredHeader = probe.headers.get(PAYMENT_REQUIRED_HEADER)
  if (!paymentRequiredHeader) {
    throw new Error('[client] 402 received but PAYMENT-REQUIRED header missing.')
  }

  // Step 2 — decode the Base64(JSON) paywall challenge.
  const spec = decodePaymentRequirements(paymentRequiredHeader)
  console.log('[client] paywall challenge:', spec)

  // Step 3 — sign EIP-3009 TransferWithAuthorization locally.
  const account = privateKeyToAccount(pk)
  const signedPayload = await generateEip3009Signature(account, spec, paymentAmount)
  const paymentSignatureHeader = Buffer.from(JSON.stringify(signedPayload)).toString('base64')

  // Step 4 — retry with PAYMENT-SIGNATURE header.
  const retry = await fetch(url, {
    method: 'GET',
    headers: { [PAYMENT_SIGNATURE_HEADER]: paymentSignatureHeader },
  })
  if (retry.status !== 200) {
    throw new Error(`[client] Retry rejected (${retry.status}): ${await retry.text()}`)
  }

  // Step 5 — verify the settlement receipt header (optional).
  const settlementHeader = retry.headers.get(PAYMENT_RESPONSE_HEADER)
  if (settlementHeader) {
    validateSettlement(settlementHeader)
  } else {
    console.warn('[client] 200 OK without PAYMENT-RESPONSE header.')
  }

  return await retry.text()
}

// Quick balance sanity check — keeps parity with the original test client
// since hitting the paywall without Gateway funds always errors at settle().
const gateway = new GatewayClient({ chain: 'arcTestnet', privateKey })
console.log(`Wallet: ${gateway.address}`)
const balances = await gateway.getBalances()
console.log(`Wallet USDC: ${balances.wallet.formatted}`)
console.log(`Gateway available: ${balances.gateway.formattedAvailable}`)
console.log(`Gateway total: ${balances.gateway.formattedTotal}\n`)
if (balances.gateway.available === 0n) {
  console.log('No Gateway balance. Run: npm run deposit -- <amount>')
  process.exit(1)
}

console.log(`Calling ${URL_} ...\n`)
try {
  const content = await fetchPaywalledResource(URL_, privateKey, PAYMENT_AMOUNT)
  console.log('Nanopayment complete!')
  console.log('Response:')
  console.log(content)
} catch (err) {
  console.error('Payment failed:', err instanceof Error ? err.message : err)
  process.exitCode = 1
}
