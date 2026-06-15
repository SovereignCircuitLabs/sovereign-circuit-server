import type { Address } from 'viem'
import { npcPricingAbi } from '../abi/npcPricingAbi.js'
import { npcPricingAddress, publicClient } from '../config.js'
import { requiredConfiguredAddress } from '../utils/validation.js'
import { contractCall } from './contractErrors.js'

function address(): Address {
  return requiredConfiguredAddress(npcPricingAddress, 'NPC_PRICING_ADDRESS')
}

async function read(functionName: string, args: readonly unknown[] = []) {
  return contractCall(`NpcPricing.${functionName}`, () =>
    publicClient.readContract({
      address: address(),
      abi: npcPricingAbi,
      functionName: functionName as never,
      args: args as never,
    }),
  )
}

export const npcPricingService = {
  getNpcClassId(tokenId: bigint) {
    return read('getNpcClassId', [tokenId]) as Promise<bigint>
  },
  getNpcTbaTotalValue(tokenId: bigint) {
    return read('getNpcTbaTotalValue', [tokenId]) as Promise<bigint>
  },
  async getNpcTbaValueBreakdown(tokenId: bigint) {
    const result = (await read('getNpcTbaValueBreakdown', [tokenId])) as readonly [
      Address,
      bigint,
      bigint,
      bigint,
    ]
    return {
      tba: result[0],
      itemValue: result[1],
      cashValue: result[2],
      tbaTotalValue: result[3],
    }
  },
  getScarcityMultiplierBps(classId: bigint) {
    return read('getScarcityMultiplierBps', [classId]) as Promise<bigint>
  },
  async quoteNpcPrice(tokenId: bigint) {
    const result = (await read('quoteNpcPrice', [tokenId])) as readonly [bigint, bigint, bigint]
    return {
      price: result[0],
      tbaTotalValue: result[1],
      scarcityMultiplierBps: result[2],
    }
  },
  async classMarkets(classId: bigint) {
    const result = (await read('classMarkets', [classId])) as readonly [
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      boolean,
    ]
    return {
      totalSupply: result[0],
      listedSupply: result[1],
      virtualLiquidity: result[2],
      basePrice: result[3],
      maxMultiplierBps: result[4],
      scarcityWeightBps: result[5],
      exists: result[6],
    }
  },
  BPS() {
    return read('BPS') as Promise<bigint>
  },
  npcCharacter() {
    return read('npcCharacter') as Promise<Address>
  },
  usdc() {
    return read('usdc') as Promise<Address>
  },
  gamePayment() {
    return read('gamePayment') as Promise<Address>
  },
}
