import { type Address } from 'viem'
import { erc1155Abi } from '../abi/erc1155Abi.js'
import { publicClient, serverAccount, walletClient } from '../config.js'
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

export const erc1155Service = {
  balanceOf(token: Address, account: Address, id: bigint) {
    return contractCall('ERC1155.balanceOf', () =>
      publicClient.readContract({
        address: token,
        abi: erc1155Abi,
        functionName: 'balanceOf',
        args: [account, id],
      }),
    )
  },

  isApprovedForAll(token: Address, account: Address, operator: Address) {
    return contractCall('ERC1155.isApprovedForAll', () =>
      publicClient.readContract({
        address: token,
        abi: erc1155Abi,
        functionName: 'isApprovedForAll',
        args: [account, operator],
      }),
    )
  },

  async setApprovalForAll(token: Address, operator: Address, approved: boolean): Promise<TxReceiptView> {
    const hash = await contractCall('ERC1155.setApprovalForAll.simulate', async () => {
      const { request } = await publicClient.simulateContract({
        address: token,
        abi: erc1155Abi,
        functionName: 'setApprovalForAll',
        args: [operator, approved],
        account: serverAccount,
      })
      return walletClient.writeContract(request)
    })
    return contractCall('ERC1155.setApprovalForAll.receipt', () => waitFor(hash))
  },
}
