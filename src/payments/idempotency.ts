import type { Address } from 'viem'

// Shape of the decoded PAYMENT-SIGNATURE payload (mirrors what the Unity client
// and src/test/client.ts emit). Only the fields we rely on are typed.
export interface PaymentPayload {
  x402Version?: number
  scheme?: string
  network?: string
  payload?: {
    signature?: string
    authorization?: {
      from?: string
      to?: string
      value?: string
      validAfter?: string
      validBefore?: string
      nonce?: string
    }
  }
  [key: string]: unknown
}

/**
 * Decode the PAYMENT-SIGNATURE header. Unity ships Base64(JSON); we also accept
 * raw JSON for hand-rolled curl-style debugging.
 */
export function decodePaymentHeader(value: string): PaymentPayload {
  const candidate = Buffer.from(value, 'base64').toString('utf-8')
  try {
    return JSON.parse(candidate) as PaymentPayload
  } catch {
    return JSON.parse(value) as PaymentPayload
  }
}

export interface PaymentIdentity {
  orderId: string // = authorization nonce; the idempotency / replay key
  authNonce: string
  payer: Address
}

/**
 * Derive the stable order identity from a decoded payment payload. The EIP-3009
 * authorization `nonce` is a 32-byte random value that is unique per signature
 * and single-use on-chain, which makes it the natural idempotency key: the same
 * payload always maps to the same order, and a replay maps to the same row.
 */
export function deriveIdentity(payload: PaymentPayload): PaymentIdentity {
  const auth = payload.payload?.authorization
  const nonce = auth?.nonce
  const from = auth?.from
  if (!nonce || !/^0x[0-9a-fA-F]{64}$/.test(nonce)) {
    throw new Error('payment payload missing a valid 32-byte authorization.nonce')
  }
  if (!from) {
    throw new Error('payment payload missing authorization.from')
  }
  const orderId = nonce.toLowerCase()
  return { orderId, authNonce: orderId, payer: from as Address }
}
