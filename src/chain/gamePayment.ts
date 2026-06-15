import { parseEventLogs, type Address, type Hex } from 'viem'
import { gamePaymentAbi } from '../abi/gamePaymentAbi.js'
import { gamePaymentAddress, publicClient, serverAccount, walletClient } from '../config.js'

export { gamePaymentAbi }

export async function loadManagedItemIds(): Promise<readonly bigint[]> {
  const ids = await publicClient.readContract({
    address: gamePaymentAddress,
    abi: gamePaymentAbi,
    functionName: 'getItemIds',
  })
  return ids as readonly bigint[]
}

export async function quoteBuyPrice(itemId: bigint): Promise<bigint> {
  return publicClient.readContract({
    address: gamePaymentAddress,
    abi: gamePaymentAbi,
    functionName: 'getBuyPrice',
    args: [itemId],
  })
}

export interface MintBroadcast {
  txHash: Hex
  nonce: number
}

/**
 * Simulate + broadcast buyItemX402 on a *pinned* wallet nonce and return the tx
 * hash immediately (without waiting for the receipt). Pinning the nonce is the
 * core double-mint guard: a retry of the same order re-broadcasts on the same
 * nonce, so at most one such tx can ever be mined.
 *
 * Pass the nonce from a prior attempt to retry deterministically; omit it for a
 * fresh order (the pending nonce is read and returned so the caller can persist
 * it before this promise resolves through to the broadcast).
 */
export async function broadcastMint(args: {
  to: Address
  itemId: bigint
  paidAmount: bigint
  maxPriceAllowed: bigint
  nonce?: number
}): Promise<MintBroadcast> {
  const nonce =
    args.nonce ??
    (await publicClient.getTransactionCount({
      address: serverAccount.address,
      blockTag: 'pending',
    }))

  const { request } = await publicClient.simulateContract({
    address: gamePaymentAddress,
    abi: gamePaymentAbi,
    functionName: 'buyItemX402',
    args: [args.to, args.itemId, args.paidAmount, args.maxPriceAllowed],
    account: serverAccount,
    nonce,
  })

  const txHash = await walletClient.writeContract(request)
  return { txHash, nonce }
}

export interface MintReceipt {
  txHash: Hex
  itemId: string
  pricePaid: string
  blockNumber: string
  status: 'success' | 'reverted'
}

/** Wait for a mint tx receipt and decode the ItemMinted event. */
export async function waitForMintReceipt(
  txHash: Hex,
  fallback: { itemId: bigint; paidAmount: bigint },
  timeoutMs?: number,
): Promise<MintReceipt> {
  const receipt = await publicClient.waitForTransactionReceipt(
    timeoutMs === undefined ? { hash: txHash } : { hash: txHash, timeout: timeoutMs },
  )
  const logs = parseEventLogs({
    abi: gamePaymentAbi,
    eventName: 'ItemMinted',
    logs: receipt.logs,
  })
  const minted = logs[0]?.args
  return {
    txHash,
    itemId: (minted?.id ?? fallback.itemId).toString(),
    pricePaid: (minted?.pricePaid ?? fallback.paidAmount).toString(),
    blockNumber: receipt.blockNumber.toString(),
    status: receipt.status,
  }
}

/**
 * Non-blocking receipt lookup. Returns the tx status if mined, or null if the
 * tx is not yet mined / unknown to the node. Used for crash-recovery
 * reconciliation where we must not block.
 */
export async function getReceiptStatus(
  txHash: Hex,
): Promise<'success' | 'reverted' | null> {
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash })
    return receipt.status
  } catch {
    return null
  }
}

/**
 * Broadcast an owner-only refund of `amount` USDC base units back into the
 * buyer's Circle Gateway balance (GamePayment.refundToGateway -> Gateway
 * depositFor), on a pinned nonce (same double-broadcast guarantee as the mint).
 * Returns the tx hash without awaiting the receipt.
 */
export async function broadcastRefund(args: {
  to: Address
  amount: bigint
  nonce?: number
}): Promise<MintBroadcast> {
  const nonce =
    args.nonce ??
    (await publicClient.getTransactionCount({
      address: serverAccount.address,
      blockTag: 'pending',
    }))

  const { request } = await publicClient.simulateContract({
    address: gamePaymentAddress,
    abi: gamePaymentAbi,
    functionName: 'refundToGateway',
    args: [args.to, args.amount],
    account: serverAccount,
    nonce,
  })

  const txHash = await walletClient.writeContract(request)
  return { txHash, nonce }
}

/** Wait for any tx receipt and return only its status. */
export async function waitForReceiptStatus(
  txHash: Hex,
  timeoutMs?: number,
): Promise<'success' | 'reverted'> {
  const receipt = await publicClient.waitForTransactionReceipt(
    timeoutMs === undefined ? { hash: txHash } : { hash: txHash, timeout: timeoutMs },
  )
  return receipt.status
}
