import 'dotenv/config'
import express from 'express'
import { CHAIN_CONFIGS } from '@circle-fin/x402-batching/client'
import { BatchFacilitatorClient } from '@circle-fin/x402-batching/server'
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  isAddress,
  parseEventLogs,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

// i.e. npc payment wallet address
const serverPrivateKey = process.env.SERVER_PRIVATE_KEY as Hex
if (!serverPrivateKey) {
  console.error('SERVER_PRIVATE_KEY not set in .env (required to call buyItemX402)')
  process.exit(1)
}

const gamePaymentAddress = process.env.GAME_PAYMENT_ADDRESS as Address
if (!gamePaymentAddress) {
  console.error('GAME_PAYMENT_ADDRESS not set in .env (deployed GamePayment contract address)')
  process.exit(1)
}

const npcNftAddress = (process.env.NPC_NFT_ADDRESS ?? '') as Address | ''
const erc6551Registry = (process.env.ERC6551_REGISTRY ?? '') as Address
const erc6551Implementation = (process.env.ERC6551_IMPLEMENTATION ?? '') as Address | ''
const erc6551Salt = (process.env.ERC6551_SALT ??
  '0x0000000000000000000000000000000000000000000000000000000000000000') as Hex

const tbaValidationEnabled =
  npcNftAddress.length > 0 && erc6551Implementation.length > 0
if (!tbaValidationEnabled) {
  console.warn(
    '[boot] TBA validation disabled — set NPC_NFT_ADDRESS and ERC6551_IMPLEMENTATION ' +
      'in .env to mint loot NFTs to the NPC TBA instead of the operator wallet.',
  )
}

const app = express()
const chainConfig = CHAIN_CONFIGS.arcTestnet
// arcTestnet lives behind the testnet Gateway; the default URL is mainnet.
const facilitator = new BatchFacilitatorClient({
  url: process.env.GATEWAY_URL ?? 'https://gateway-api-testnet.circle.com',
})
const network = `eip155:${chainConfig.chain.id}`

const PAYMENT_REQUIRED_HEADER = 'PAYMENT-REQUIRED'
const PAYMENT_SIGNATURE_HEADER = 'PAYMENT-SIGNATURE'
const PAYMENT_RESPONSE_HEADER = 'PAYMENT-RESPONSE'
const NPC_TBA_HEADER = 'X-NPC-TBA'
const NPC_TOKEN_ID_HEADER = 'X-NPC-TOKEN-ID'

const gamePaymentAbi = [
  {
    type: 'function',
    name: 'getBuyPrice',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getItemIds',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256[5]' }],
  },
  {
    type: 'function',
    name: 'buyItemX402',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'id', type: 'uint256' },
      { name: 'paidAmount', type: 'uint256' },
      { name: 'maxPriceAllowed', type: 'uint256' },
    ],
    outputs: [{ name: 'price', type: 'uint256' }],
  },
  {
    type: 'event',
    name: 'ItemMinted',
    inputs: [
      { name: 'buyer', type: 'address', indexed: true },
      { name: 'id', type: 'uint256', indexed: true },
      { name: 'pricePaid', type: 'uint256', indexed: false },
    ],
  },
] as const

const npcCharacterAbi = [
  {
    type: 'function',
    name: 'getPaymentBinding',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [
      { name: 'wallet', type: 'address' },
      { name: 'version', type: 'uint64' },
    ],
  },
] as const

const erc6551RegistryAbi = [
  {
    type: 'function',
    name: 'account',
    stateMutability: 'view',
    inputs: [
      { name: 'implementation', type: 'address' },
      { name: 'salt', type: 'bytes32' },
      { name: 'chainId', type: 'uint256' },
      { name: 'tokenContract', type: 'address' },
      { name: 'tokenId', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'address' }],
  },
] as const

const serverAccount = privateKeyToAccount(serverPrivateKey)
const rpcTransport = http(chainConfig.rpcUrl)
const publicClient = createPublicClient({ chain: chainConfig.chain, transport: rpcTransport })
const walletClient = createWalletClient({
  chain: chainConfig.chain,
  account: serverAccount,
  transport: rpcTransport,
})

// Cached list of managed item ids — read once at boot, used to validate the
// `:id` URL parameter without an RPC round-trip per request.
let managedItemIds: readonly bigint[] = []

async function loadManagedItemIds() {
  const ids = await publicClient.readContract({
    address: gamePaymentAddress,
    abi: gamePaymentAbi,
    functionName: 'getItemIds',
  })
  managedItemIds = ids as readonly bigint[]
}

async function quoteBuyPrice(itemId: bigint): Promise<bigint> {
  return publicClient.readContract({
    address: gamePaymentAddress,
    abi: gamePaymentAbi,
    functionName: 'getBuyPrice',
    args: [itemId],
  })
}

async function buyItemOnChain(args: {
  to: Address
  itemId: bigint
  paidAmount: bigint
  maxPriceAllowed: bigint
}) {
  const { request } = await publicClient.simulateContract({
    address: gamePaymentAddress,
    abi: gamePaymentAbi,
    functionName: 'buyItemX402',
    args: [args.to, args.itemId, args.paidAmount, args.maxPriceAllowed],
    account: serverAccount,
  })

  const txHash = await walletClient.writeContract(request)
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash })

  const logs = parseEventLogs({
    abi: gamePaymentAbi,
    eventName: 'ItemMinted',
    logs: receipt.logs,
  })
  const minted = logs[0]?.args

  return {
    txHash,
    itemId: (minted?.id ?? args.itemId).toString(),
    pricePaid: (minted?.pricePaid ?? args.paidAmount).toString(),
    blockNumber: receipt.blockNumber.toString(),
    status: receipt.status,
  }
}

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

async function validateTbaForNpc(args: {
  payer: Address
  claimedTba: Address
  tokenId: bigint
}) {
  if (!tbaValidationEnabled) {
    throw new Error(
      'TBA validation requested but server is not configured ' +
        '(NPC_NFT_ADDRESS / ERC6551_IMPLEMENTATION missing in .env).',
    )
  }

  const [binding, computedTba] = await Promise.all([
    publicClient.readContract({
      address: npcNftAddress as Address,
      abi: npcCharacterAbi,
      functionName: 'getPaymentBinding',
      args: [args.tokenId],
    }),
    publicClient.readContract({
      address: erc6551Registry,
      abi: erc6551RegistryAbi,
      functionName: 'account',
      args: [
        erc6551Implementation as Address,
        erc6551Salt,
        BigInt(chainConfig.chain.id),
        npcNftAddress as Address,
        args.tokenId,
      ],
    }),
  ])

  const boundWallet = binding[0] as Address
  if (boundWallet.toLowerCase() !== args.payer.toLowerCase()) {
    throw new Error(
      `Payer ${args.payer} is not the bound operator wallet for NPC ${args.tokenId} ` +
        `(chain says ${boundWallet}).`,
    )
  }

  if ((computedTba as Address).toLowerCase() !== args.claimedTba.toLowerCase()) {
    throw new Error(
      `Claimed TBA ${args.claimedTba} does not match ERC6551 account for NPC ${args.tokenId} ` +
        `(registry computed ${computedTba}).`,
    )
  }
}

async function resolveMintRecipient(
  req: express.Request,
  payer: Address,
): Promise<{ recipient: Address; kind: 'payer' | 'tba' }> {
  const tbaHeaderRaw = req.headers[NPC_TBA_HEADER.toLowerCase()]
  const tokenIdHeaderRaw = req.headers[NPC_TOKEN_ID_HEADER.toLowerCase()]

  if (!tbaHeaderRaw && !tokenIdHeaderRaw) {
    console.warn(
      `[tba] no X-NPC-TBA/X-NPC-TOKEN-ID headers from ${payer} — falling back to ` +
        'mint-to-payer. Update the Unity client to route loot to the NPC TBA.',
    )
    return { recipient: payer, kind: 'payer' }
  }

  const tbaStr = String(tbaHeaderRaw ?? '')
  const tokenIdStr = String(tokenIdHeaderRaw ?? '')
  if (!isAddress(tbaStr)) throw new Error(`Bad ${NPC_TBA_HEADER} header: ${tbaStr}`)
  if (!/^\d+$/.test(tokenIdStr))
    throw new Error(`Bad ${NPC_TOKEN_ID_HEADER} header: ${tokenIdStr}`)

  const tba = getAddress(tbaStr)
  const tokenId = BigInt(tokenIdStr)
  await validateTbaForNpc({ payer, claimedTba: tba, tokenId })
  console.log(`[tba] validated tokenId=${tokenId} tba=${tba} payer=${payer}`)
  return { recipient: tba, kind: 'tba' }
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

      console.log(
        `[402] ${req.method} ${req.originalUrl} -> ${quotedPrice.toString()} (USDC base units)`,
      )

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
    console.log(`[pay] verifying authorization from ${payerHint} for item ${itemId.toString()}`)

    const enrichedPayload = {
      ...paymentPayload,
      resource: {
        url: req.originalUrl,
        description: `GameItem #${itemId.toString()}`,
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

    const payer = (settleResult.payer ?? verifyResult.payer) as Address
    console.log(`[pay] settled tx=${settleResult.transaction} payer=${payer}`)

    res.setHeader(
      PAYMENT_RESPONSE_HEADER,
      Buffer.from(
        JSON.stringify({
          success: true,
          transaction: settleResult.transaction,
          network: requirements.network,
          payer,
        }),
      ).toString('base64'),
    )

    let recipientInfo: { recipient: Address; kind: 'payer' | 'tba' }
    try {
      recipientInfo = await resolveMintRecipient(req, payer)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      console.warn(`[tba] validation failed; refusing to mint: ${reason}`)
      res.json({
        x402_tx: settleResult.transaction,
        payer,
        payTo: requirements.payTo,
        amount: requirements.amount,
        item_id: itemId.toString(),
        quoted_price: quotedPrice.toString(),
        mint: { error: reason, recipient_kind: 'payer' },
      })
      return
    }

    let buyResult: Awaited<ReturnType<typeof buyItemOnChain>> | null = null
    let buyError: string | null = null
    try {
      buyResult = await buyItemOnChain({
        to: recipientInfo.recipient,
        itemId,
        paidAmount: quotedPrice,
        maxPriceAllowed: quotedPrice,
      })
      console.log(
        `[mint] tx=${buyResult.txHash} buyer=${recipientInfo.recipient} (${recipientInfo.kind}) ` +
          `id=${buyResult.itemId} price=${buyResult.pricePaid} status=${buyResult.status}`,
      )
    } catch (err) {
      buyError = err instanceof Error ? err.message : String(err)
      console.warn(`[mint] buyItemX402 failed for ${recipientInfo.recipient}: ${buyError}`)
    }

    res.json({
      x402_tx: settleResult.transaction,
      payer,
      payTo: requirements.payTo,
      amount: requirements.amount,
      item_id: itemId.toString(),
      quoted_price: quotedPrice.toString(),
      mint: buyResult
        ? {
            tx_hash: buyResult.txHash,
            item_id: buyResult.itemId,
            price_paid: buyResult.pricePaid,
            block_number: buyResult.blockNumber,
            status: buyResult.status,
            recipient: recipientInfo.recipient,
            recipient_kind: recipientInfo.kind,
          }
        : { error: buyError, recipient_kind: recipientInfo.kind },
    })
  } catch (error) {
    next(error)
  }
})

await loadManagedItemIds()
console.log(
  `[boot] cached ${managedItemIds.length} managed item ids: ` +
    managedItemIds.map((x) => x.toString()).join(', '),
)

app.listen(4021, () => {
  console.log('Server on http://localhost:4021')
  console.log('Paywall: GET /item/:id -> USDC nanopayment (Circle Gateway) + buyItemX402')
  console.log(`GamePayment contract: ${gamePaymentAddress}`)
  console.log(`Minter (onlyOwner) : ${serverAccount.address}`)
  if (tbaValidationEnabled) {
    console.log(
      `TBA routing  : enabled (registry=${erc6551Registry}, npc=${npcNftAddress})`,
    )
  } else {
    console.log('TBA routing  : DISABLED — mints land on operator wallet (legacy)')
  }
})