import { getAddress, isAddress, type Address, type Hex } from 'viem'
import { gamePaymentAbi } from '../abi/gamePaymentAbi.js'
import { gamePaymentAddress, publicClient, serverAccount, walletClient } from '../config.js'
import { contractCall } from './contractErrors.js'

export interface TxReceiptView {
  txHash: Hex
  status: 'success' | 'reverted'
  blockNumber: string
  gasUsed: string
}

export function assertAddress(value: unknown, fieldName: string): Address {
  if (typeof value !== 'string' || !isAddress(value)) {
    throw new Error(`${fieldName} must be a valid EVM address`)
  }
  return getAddress(value)
}

export function assertUintParam(value: string | undefined, fieldName: string): bigint {
  if (!value || !/^\d+$/.test(value)) {
    throw new Error(`${fieldName} must be a uint256 decimal string`)
  }
  return BigInt(value)
}

async function readGamePayment(functionName: string, args: readonly unknown[] = []) {
  return contractCall(`GamePayment.${functionName}`, () =>
    publicClient.readContract({
      address: gamePaymentAddress,
      abi: gamePaymentAbi,
      functionName: functionName as never,
      args: args as never,
    }),
  )
}

async function writeGamePayment(functionName: string, args: readonly unknown[] = []): Promise<TxReceiptView> {
  const hash = await contractCall(`GamePayment.${functionName}.simulate`, async () => {
    const { request } = await publicClient.simulateContract({
      address: gamePaymentAddress,
      abi: gamePaymentAbi,
      functionName: functionName as never,
      args: args as never,
      account: serverAccount,
    })
    return walletClient.writeContract(request)
  })

  const receipt = await contractCall(`GamePayment.${functionName}.receipt`, () =>
    publicClient.waitForTransactionReceipt({ hash }),
  )
  return {
    txHash: hash,
    status: receipt.status,
    blockNumber: receipt.blockNumber.toString(),
    gasUsed: receipt.gasUsed.toString(),
  }
}

function idsAndBalances(ids: readonly bigint[], balances: readonly bigint[]) {
  return ids.map((id, index) => ({
    id: id.toString(),
    balance: (balances[index] ?? 0n).toString(),
  }))
}

export const gamePaymentService = {
  async constants() {
    const [
      baselinePrice,
      priceSlope,
      sellSpreadBps,
      bpsDenominator,
      numTypes,
      usdc,
      items,
      owner,
      gateway,
      manager,
      activeTypeCount,
    ] = await Promise.all([
      readGamePayment('BASELINE_PRICE') as Promise<bigint>,
      readGamePayment('PRICE_SLOPE') as Promise<bigint>,
      readGamePayment('SELL_SPREAD_BPS') as Promise<bigint>,
      readGamePayment('BPS_DENOMINATOR') as Promise<bigint>,
      readGamePayment('NUM_TYPES') as Promise<bigint>,
      readGamePayment('usdc') as Promise<Address>,
      readGamePayment('items') as Promise<Address>,
      readGamePayment('owner') as Promise<Address>,
      readGamePayment('gateway') as Promise<Address>,
      readGamePayment('manager') as Promise<Address>,
      readGamePayment('activeTypeCount') as Promise<bigint>,
    ])
    return {
      BASELINE_PRICE: baselinePrice,
      PRICE_SLOPE: priceSlope,
      SELL_SPREAD_BPS: sellSpreadBps,
      BPS_DENOMINATOR: bpsDenominator,
      NUM_TYPES: numTypes,
      usdc,
      items,
      owner,
      gateway,
      manager,
      activeTypeCount,
    }
  },

  npcTba(tokenId: bigint) {
    return readGamePayment('npcTba', [tokenId]) as Promise<Address>
  },
  itemsAddress() {
    return readGamePayment('items') as Promise<Address>
  },
  itemId(index: bigint) {
    return readGamePayment('itemIds', [index]) as Promise<bigint>
  },
  circulatingSupply(id: bigint) {
    return readGamePayment('circulatingSupply', [id]) as Promise<bigint>
  },
  getBuyPrice(id: bigint) {
    return readGamePayment('getBuyPrice', [id]) as Promise<bigint>
  },
  getSellPrice(id: bigint) {
    return readGamePayment('getSellPrice', [id]) as Promise<bigint>
  },
  getContractBalance() {
    return readGamePayment('getContractBalance') as Promise<bigint>
  },
  gatewayAvailableBalance() {
    return readGamePayment('gatewayAvailableBalance') as Promise<bigint>
  },
  gatewayWithdrawableBalance() {
    return readGamePayment('gatewayWithdrawableBalance') as Promise<bigint>
  },
  gatewayWithdrawingBalance() {
    return readGamePayment('gatewayWithdrawingBalance') as Promise<bigint>
  },
  gatewayTotalBalance() {
    return readGamePayment('gatewayTotalBalance') as Promise<bigint>
  },
  gatewayWithdrawalBlock() {
    return readGamePayment('gatewayWithdrawalBlock') as Promise<bigint>
  },
  gatewayWithdrawalDelay() {
    return readGamePayment('gatewayWithdrawalDelay') as Promise<bigint>
  },
  isGatewayAuthorized(addr: Address) {
    return readGamePayment('isGatewayAuthorized', [addr]) as Promise<boolean>
  },
  isGatewayTokenSupported() {
    return readGamePayment('isGatewayTokenSupported') as Promise<boolean>
  },
  getItemIds() {
    return readGamePayment('getItemIds') as Promise<readonly bigint[]>
  },
  getAllBuyPrices() {
    return readGamePayment('getAllBuyPrices') as Promise<readonly bigint[]>
  },
  getAllSellPrices() {
    return readGamePayment('getAllSellPrices') as Promise<readonly bigint[]>
  },

  async getPrices() {
    const [ids, buyPrices, sellPrices] = await Promise.all([
      this.getItemIds(),
      this.getAllBuyPrices(),
      this.getAllSellPrices(),
    ])
    return ids.map((id, index) => ({
      id,
      buyPrice: buyPrices[index] ?? 0n,
      sellPrice: sellPrices[index] ?? 0n,
    }))
  },

  async getTbaItemBalances(tba: Address) {
    const result = (await readGamePayment('getTbaItemBalances', [tba])) as readonly [
      readonly bigint[],
      readonly bigint[],
    ]
    return idsAndBalances(result[0], result[1])
  },
  async getTbaOwnedItems(tba: Address) {
    const result = (await readGamePayment('getTbaOwnedItems', [tba])) as readonly [
      readonly bigint[],
      readonly bigint[],
    ]
    return idsAndBalances(result[0], result[1])
  },
  async getNpcTbaItemBalances(tokenId: bigint) {
    const result = (await readGamePayment('getNpcTbaItemBalances', [tokenId])) as readonly [
      Address,
      readonly bigint[],
      readonly bigint[],
    ]
    return { tba: result[0], items: idsAndBalances(result[1], result[2]) }
  },
  async getNpcTbaOwnedItems(tokenId: bigint) {
    const result = (await readGamePayment('getNpcTbaOwnedItems', [tokenId])) as readonly [
      Address,
      readonly bigint[],
      readonly bigint[],
    ]
    return { tba: result[0], items: idsAndBalances(result[1], result[2]) }
  },

  mintRandom(maxPriceAllowed: bigint) {
    return writeGamePayment('mintRandom', [maxPriceAllowed])
  },
  mintRandomX402(to: Address) {
    return writeGamePayment('mintRandomX402', [to])
  },
  buyItemX402(to: Address, id: bigint, paidAmount: bigint, maxPriceAllowed: bigint) {
    return writeGamePayment('buyItemX402', [to, id, paidAmount, maxPriceAllowed])
  },
  sellItem(id: bigint) {
    return writeGamePayment('sellItem', [id])
  },
  setGateway(gateway: Address) {
    return writeGamePayment('setGateway', [gateway])
  },
  depositToGateway(amount: bigint) {
    return writeGamePayment('depositToGateway', [amount])
  },
  initiateGatewayWithdrawal(amount: bigint) {
    return writeGamePayment('initiateGatewayWithdrawal', [amount])
  },
  completeGatewayWithdrawal() {
    return writeGamePayment('completeGatewayWithdrawal')
  },
  addGatewayDelegate(delegate: Address) {
    return writeGamePayment('addGatewayDelegate', [delegate])
  },
  removeGatewayDelegate(delegate: Address) {
    return writeGamePayment('removeGatewayDelegate', [delegate])
  },
  setManager(manager: Address) {
    return writeGamePayment('setManager', [manager])
  },
  transferOwnership(newOwner: Address) {
    return writeGamePayment('transferOwnership', [newOwner])
  },
}
