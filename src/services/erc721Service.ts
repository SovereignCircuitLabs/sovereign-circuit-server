import type { Address } from 'viem'
import { erc721Abi } from '../abi/erc721Abi.js'
import { npcNftAddress, publicClient, serverAccount, walletClient } from '../config.js'
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

function tokenAddress(address: Address | '' = npcNftAddress): Address {
  return requiredConfiguredAddress(address, 'NPC_NFT_ADDRESS')
}

export const erc721Service = {
  isApprovedForAll(owner: Address, operator: Address, token?: Address) {
    return contractCall('ERC721.isApprovedForAll', () =>
      publicClient.readContract({
        address: tokenAddress(token),
        abi: erc721Abi,
        functionName: 'isApprovedForAll',
        args: [owner, operator],
      }),
    )
  },

  getApproved(tokenId: bigint, token?: Address) {
    return contractCall('ERC721.getApproved', () =>
      publicClient.readContract({
        address: tokenAddress(token),
        abi: erc721Abi,
        functionName: 'getApproved',
        args: [tokenId],
      }),
    )
  },

  async setApprovalForAll(operator: Address, approved: boolean, token?: Address): Promise<TxReceiptView> {
    const address = tokenAddress(token)
    const hash = await contractCall('ERC721.setApprovalForAll.simulate', async () => {
      const { request } = await publicClient.simulateContract({
        address,
        abi: erc721Abi,
        functionName: 'setApprovalForAll',
        args: [operator, approved],
        account: serverAccount,
      })
      return walletClient.writeContract(request)
    })
    return contractCall('ERC721.setApprovalForAll.receipt', () => waitFor(hash))
  },

  async approve(to: Address, tokenId: bigint, token?: Address): Promise<TxReceiptView> {
    const address = tokenAddress(token)
    const hash = await contractCall('ERC721.approve.simulate', async () => {
      const { request } = await publicClient.simulateContract({
        address,
        abi: erc721Abi,
        functionName: 'approve',
        args: [to, tokenId],
        account: serverAccount,
      })
      return walletClient.writeContract(request)
    })
    return contractCall('ERC721.approve.receipt', () => waitFor(hash))
  },
}
