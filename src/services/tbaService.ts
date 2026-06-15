import { getAddress, isAddress, type Address, type Hex } from 'viem'
import { erc6551AccountAbi } from '../abi/erc6551AccountAbi.js'
import { gamePaymentAddress, publicClient, serverAccount, walletClient } from '../config.js'
import { contractCall } from './contractErrors.js'
import type { TxReceiptView } from './gamePaymentService.js'

function envAllowedTargets(): Address[] {
  const raw = process.env.TBA_EXECUTE_ALLOWED_TARGETS ?? ''
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && isAddress(item))
    .map((item) => getAddress(item))
}

function allowedTargets(extraTargets: readonly Address[] = []): Set<string> {
  return new Set(
    [gamePaymentAddress, ...envAllowedTargets(), ...extraTargets].map((address) =>
      address.toLowerCase(),
    ),
  )
}

function assertHexData(value: unknown): Hex {
  if (typeof value !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(value)) {
    throw new Error('data must be 0x-prefixed hex bytes')
  }
  return value as Hex
}

async function waitFor(hash: Hex): Promise<TxReceiptView> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  return {
    txHash: hash,
    status: receipt.status,
    blockNumber: receipt.blockNumber.toString(),
    gasUsed: receipt.gasUsed.toString(),
  }
}

export const tbaService = {
  execute(args: {
    account: Address
    to: Address
    value: bigint
    data: Hex
    operation: number
    extraAllowedTargets?: readonly Address[]
  }): Promise<TxReceiptView> {
    if (args.operation !== 0) {
      throw new Error('Only CALL operation (0) is allowed for TBA execute')
    }
    if (args.value !== 0n) {
      throw new Error('TBA execute value must be 0')
    }
    if (!allowedTargets(args.extraAllowedTargets).has(args.to.toLowerCase())) {
      throw new Error(`TBA execute target ${args.to} is not allowed`)
    }
    assertHexData(args.data)

    return contractCall('ERC6551.execute', async () => {
      const { request } = await publicClient.simulateContract({
        address: args.account,
        abi: erc6551AccountAbi,
        functionName: 'execute',
        args: [args.to, args.value, args.data, args.operation],
        account: serverAccount,
      })
      const hash = await walletClient.writeContract(request)
      return waitFor(hash)
    })
  },
}
