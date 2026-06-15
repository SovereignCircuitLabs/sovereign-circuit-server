import type { Address } from 'viem'
import { npcCharacterAbi } from '../abi/npcCharacterAbi.js'
import { npcNftAddress, publicClient, serverAccount, walletClient } from '../config.js'
import { requiredConfiguredAddress } from '../utils/validation.js'
import { contractCall } from './contractErrors.js'
import type { TxReceiptView } from './gamePaymentService.js'

type NpcTuple = readonly [
  string,
  string,
  number,
  number,
  number,
  number,
  readonly [number, number, number, bigint, bigint, number, number, bigint, bigint],
]

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

function npcView(npc: NpcTuple) {
  const portfolio = npc[6]
  return {
    npcName: npc[0],
    metadataURI: npc[1],
    archetype: npc[2],
    riskLevel: npc[3],
    level: npc[4],
    reputation: npc[5],
    portfolio: {
      livingNeedsWeightBps: portfolio[0],
      reserveWeightBps: portfolio[1],
      tradingWeightBps: portfolio[2],
      minimumLivingBudgetUSDC: portfolio[3],
      minimumReserveBudgetUSDC: portfolio[4],
      rebalanceIntervalSeconds: portfolio[5],
      chainActionCooldownSeconds: portfolio[6],
      minTradeUSDC: portfolio[7],
      maxTradeUSDC: portfolio[8],
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
    return npcView((await read('getNpc', [tokenId])) as NpcTuple)
  },
  bindPaymentWallet(tokenId: bigint, wallet: Address) {
    return write('bindPaymentWallet', [tokenId, wallet])
  },
  clearPaymentWallet(tokenId: bigint) {
    return write('clearPaymentWallet', [tokenId])
  },
}
