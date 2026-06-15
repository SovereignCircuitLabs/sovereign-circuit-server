import type { Address } from 'viem'
import { npcMarketplaceAbi } from '../abi/npcMarketplaceAbi.js'
import { npcMarketplaceAddress, publicClient, serverAccount, walletClient } from '../config.js'
import { requiredConfiguredAddress } from '../utils/validation.js'
import { contractCall } from './contractErrors.js'
import type { TxReceiptView } from './gamePaymentService.js'

async function waitFor(hash: `0x${string}`): Promise<TxReceiptView> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  return {
    txHash: hash,
    status: receipt.status,
    blockNumber: receipt.blockNumber.toString(),
    gasUsed: receipt.gasUsed.toString(),
  }
}

function address(): Address {
  return requiredConfiguredAddress(npcMarketplaceAddress, 'NPC_MARKETPLACE_ADDRESS')
}

function listingView(result: readonly [Address, bigint, boolean]) {
  return { seller: result[0], minPrice: result[1], active: result[2] }
}

async function read(functionName: string, args: readonly unknown[] = []) {
  return contractCall(`NpcMarketplace.${functionName}`, () =>
    publicClient.readContract({
      address: address(),
      abi: npcMarketplaceAbi,
      functionName: functionName as never,
      args: args as never,
    }),
  )
}

async function write(functionName: string, args: readonly unknown[]): Promise<TxReceiptView> {
  const hash = await contractCall(`NpcMarketplace.${functionName}.simulate`, async () => {
    const { request } = await publicClient.simulateContract({
      address: address(),
      abi: npcMarketplaceAbi,
      functionName: functionName as never,
      args: args as never,
      account: serverAccount,
    })
    return walletClient.writeContract(request)
  })
  return contractCall(`NpcMarketplace.${functionName}.receipt`, () => waitFor(hash))
}

export const npcMarketplaceService = {
  async getListing(tokenId: bigint) {
    return listingView((await read('getListing', [tokenId])) as readonly [Address, bigint, boolean])
  },
  async listings(tokenId: bigint) {
    return listingView((await read('listings', [tokenId])) as readonly [Address, bigint, boolean])
  },
  npcCharacter() {
    return read('npcCharacter') as Promise<Address>
  },
  pricing() {
    return read('pricing') as Promise<Address>
  },
  usdc() {
    return read('usdc') as Promise<Address>
  },
  listNpc(tokenId: bigint, minPrice: bigint) {
    return write('listNpc', [tokenId, minPrice])
  },
  cancelListing(tokenId: bigint) {
    return write('cancelListing', [tokenId])
  },
  clearStaleListing(tokenId: bigint) {
    return write('clearStaleListing', [tokenId])
  },
  buyNpc(tokenId: bigint, maxPrice: bigint) {
    return write('buyNpc', [tokenId, maxPrice])
  },
}
