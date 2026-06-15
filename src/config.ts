import 'dotenv/config'
import { CHAIN_CONFIGS } from '@circle-fin/x402-batching/client'
import { BatchFacilitatorClient } from '@circle-fin/x402-batching/server'
import { createPublicClient, createWalletClient, http, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

// Centralised environment + client wiring. Every other module imports the
// already-constructed singletons from here so there is exactly one wallet
// (one on-chain nonce owner) and one DB path across the process.

function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    console.error(`${name} not set in .env`)
    process.exit(1)
  }
  return value
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

// --- Chain clients ---------------------------------------------------------

export const chainConfig = CHAIN_CONFIGS.arcTestnet
export const network = `eip155:${chainConfig.chain.id}`

// --- Secrets / addresses ---------------------------------------------------

export const serverPrivateKey = required('SERVER_PRIVATE_KEY') as Hex
export const gamePaymentAddress = required('GAME_PAYMENT_ADDRESS') as Address

export const npcNftAddress = (process.env.NPC_NFT_ADDRESS ?? process.env.NPC_CHARACTER_ADDRESS ?? '') as Address | ''
export const npcMarketplaceAddress = (process.env.NPC_MARKETPLACE_ADDRESS ?? '') as Address | ''
export const npcPricingAddress = (process.env.NPC_PRICING_ADDRESS ?? '') as Address | ''
export const usdcAddress = (process.env.USDC_ADDRESS ?? chainConfig.usdc) as Address
export const gatewayWalletAddress = (process.env.GATEWAY_WALLET_ADDRESS ?? '') as Address | ''
export const erc6551Registry = (process.env.ERC6551_REGISTRY ?? '') as Address
export const erc6551Implementation = (process.env.ERC6551_IMPLEMENTATION ?? '') as Address | ''
export const erc6551Salt = (process.env.ERC6551_SALT ??
  '0x0000000000000000000000000000000000000000000000000000000000000000') as Hex

export const tbaValidationEnabled =
  npcNftAddress.length > 0 && erc6551Implementation.length > 0

export const serverAccount = privateKeyToAccount(serverPrivateKey)
export const rpcUrl = process.env.ARC_RPC_URL ?? chainConfig.rpcUrl
const rpcTransport = http(rpcUrl)
export const publicClient = createPublicClient({
  chain: chainConfig.chain,
  transport: rpcTransport,
})
export const walletClient = createWalletClient({
  chain: chainConfig.chain,
  account: serverAccount,
  transport: rpcTransport,
})

// arcTestnet lives behind the testnet Gateway; the default URL is mainnet.
export const facilitator = new BatchFacilitatorClient({
  url: process.env.GATEWAY_URL ?? 'https://gateway-api-testnet.circle.com',
})

// --- HTTP headers ----------------------------------------------------------

export const PAYMENT_REQUIRED_HEADER = 'PAYMENT-REQUIRED'
export const PAYMENT_SIGNATURE_HEADER = 'PAYMENT-SIGNATURE'
export const PAYMENT_RESPONSE_HEADER = 'PAYMENT-RESPONSE'
export const NPC_TBA_HEADER = 'X-NPC-TBA'
export const NPC_TOKEN_ID_HEADER = 'X-NPC-TOKEN-ID'

// --- Order pipeline policy -------------------------------------------------

export const orderDbPath = process.env.ORDER_DB_PATH ?? 'data/orders.db'
export const adminToken = process.env.ADMIN_TOKEN ?? ''

export const retryPolicy = {
  mintMaxAttempts: intEnv('MINT_MAX_ATTEMPTS', 5),
  refundMaxAttempts: intEnv('REFUND_MAX_ATTEMPTS', 5),
  baseMs: intEnv('RETRY_BASE_MS', 2000),
  capMs: intEnv('RETRY_CAP_MS', 60000),
  tickMs: intEnv('RETRY_TICK_MS', 4000),
} as const
