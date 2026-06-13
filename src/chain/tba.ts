import { getAddress, isAddress, type Address } from 'viem'
import {
  chainConfig,
  erc6551Implementation,
  erc6551Registry,
  erc6551Salt,
  npcNftAddress,
  NPC_TBA_HEADER,
  NPC_TOKEN_ID_HEADER,
  publicClient,
  tbaValidationEnabled,
} from '../config.js'
import { log } from '../logger.js'
import type { RecipientKind } from '../orders/types.js'

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

async function validateTbaForNpc(args: {
  payer: Address
  claimedTba: Address
  tokenId: bigint
}): Promise<void> {
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

export interface ResolvedRecipient {
  recipient: Address
  kind: RecipientKind
}

/**
 * Resolve where loot should mint from the raw X-NPC-TBA / X-NPC-TOKEN-ID
 * headers. Falls back to mint-to-payer when no headers are present; throws on
 * malformed headers or failed on-chain TBA validation (caller must refuse to
 * mint in that case).
 */
export async function resolveMintRecipient(args: {
  payer: Address
  tbaHeader: string | undefined
  tokenIdHeader: string | undefined
}): Promise<ResolvedRecipient> {
  const { payer, tbaHeader, tokenIdHeader } = args

  if (!tbaHeader && !tokenIdHeader) {
    log.warn('tba.fallback_to_payer', {
      payer,
      detail: `no ${NPC_TBA_HEADER}/${NPC_TOKEN_ID_HEADER} headers — minting to payer`,
    })
    return { recipient: payer, kind: 'payer' }
  }

  const tbaStr = String(tbaHeader ?? '')
  const tokenIdStr = String(tokenIdHeader ?? '')
  if (!isAddress(tbaStr)) throw new Error(`Bad ${NPC_TBA_HEADER} header: ${tbaStr}`)
  if (!/^\d+$/.test(tokenIdStr)) throw new Error(`Bad ${NPC_TOKEN_ID_HEADER} header: ${tokenIdStr}`)

  const tba = getAddress(tbaStr)
  const tokenId = BigInt(tokenIdStr)
  await validateTbaForNpc({ payer, claimedTba: tba, tokenId })
  log.info('tba.validated', { payer, tokenId: tokenId.toString(), tba })
  return { recipient: tba, kind: 'tba' }
}
