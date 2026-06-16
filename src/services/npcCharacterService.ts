import type { Address } from 'viem'
import { npcCharacterAbi } from '../abi/npcCharacterAbi.js'
import { npcNftAddress, publicClient, serverAccount, walletClient } from '../config.js'
import { requiredConfiguredAddress } from '../utils/validation.js'
import { contractCall } from './contractErrors.js'
import type { TxReceiptView } from './gamePaymentService.js'

type NpcPortfolioStruct = {
  livingNeedsWeightBps: number
  reserveWeightBps: number
  tradingWeightBps: number
  minimumLivingBudgetUSDC: bigint
  minimumReserveBudgetUSDC: bigint
  rebalanceIntervalSeconds: number
  chainActionCooldownSeconds: number
  minTradeUSDC: bigint
  maxTradeUSDC: bigint
}

type NpcStruct = {
  npcName: string
  metadataURI: string
  archetype: number
  riskLevel: number
  level: number
  reputation: number
  portfolio: NpcPortfolioStruct
}

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
  return requiredConfiguredAddress(npcNftAddress, 'NPC_NFT_ADDRESS')
}

async function read(functionName: string, args: readonly unknown[] = []) {
  return contractCall(`NpcCharacter.${functionName}`, () =>
    publicClient.readContract({
      address: address(),
      abi: npcCharacterAbi,
      functionName: functionName as never,
      args: args as never,
    }),
  )
}

async function write(functionName: string, args: readonly unknown[]): Promise<TxReceiptView> {
  const hash = await contractCall(`NpcCharacter.${functionName}.simulate`, async () => {
    const { request } = await publicClient.simulateContract({
      address: address(),
      abi: npcCharacterAbi,
      functionName: functionName as never,
      args: args as never,
      account: serverAccount,
    })
    return walletClient.writeContract(request)
  })
  return contractCall(`NpcCharacter.${functionName}.receipt`, () => waitFor(hash))
}

function npcView(npc: NpcStruct) {
  const p = npc.portfolio
  return {
    npcName: npc.npcName,
    metadataURI: npc.metadataURI,
    archetype: npc.archetype,
    riskLevel: npc.riskLevel,
    level: npc.level,
    reputation: npc.reputation,
    portfolio: {
      livingNeedsWeightBps: p.livingNeedsWeightBps,
      reserveWeightBps: p.reserveWeightBps,
      tradingWeightBps: p.tradingWeightBps,
      minimumLivingBudgetUSDC: p.minimumLivingBudgetUSDC,
      minimumReserveBudgetUSDC: p.minimumReserveBudgetUSDC,
      rebalanceIntervalSeconds: p.rebalanceIntervalSeconds,
      chainActionCooldownSeconds: p.chainActionCooldownSeconds,
      minTradeUSDC: p.minTradeUSDC,
      maxTradeUSDC: p.maxTradeUSDC,
    },
  }
}

export const npcCharacterService = {
  async getPaymentBinding(tokenId: bigint) {
    const result = (await read('getPaymentBinding', [tokenId])) as readonly [Address, bigint]
    return { wallet: result[0], version: result[1] }
  },
  ownerOf(tokenId: bigint) {
    return read('ownerOf', [tokenId]) as Promise<Address>
  },
  exists(tokenId: bigint) {
    return read('exists', [tokenId]) as Promise<boolean>
  },
  balanceOf(owner: Address) {
    return read('balanceOf', [owner]) as Promise<bigint>
  },
  nextTokenId() {
    return read('nextTokenId') as Promise<bigint>
  },
  async getNpc(tokenId: bigint) {
    return npcView((await read('getNpc', [tokenId])) as NpcStruct)
  },
  bindPaymentWallet(tokenId: bigint, wallet: Address) {
    return write('bindPaymentWallet', [tokenId, wallet])
  },
  clearPaymentWallet(tokenId: bigint) {
    return write('clearPaymentWallet', [tokenId])
  },
}
