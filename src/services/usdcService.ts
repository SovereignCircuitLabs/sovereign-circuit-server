import type { Address } from 'viem'
import { erc20Abi } from '../abi/erc20Abi.js'
import { publicClient, serverAccount, usdcAddress, walletClient } from '../config.js'
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

function tokenAddress(address: Address | '' = usdcAddress): Address {
  return requiredConfiguredAddress(address, 'USDC_ADDRESS')
}

async function writeErc20(
  functionName: 'approve' | 'transfer',
  args: readonly [Address, bigint],
  token: Address = tokenAddress(),
): Promise<TxReceiptView> {
  const hash = await contractCall(`ERC20.${functionName}.simulate`, async () => {
    const { request } = await publicClient.simulateContract({
      address: token,
      abi: erc20Abi,
      functionName,
      args,
      account: serverAccount,
    })
    return walletClient.writeContract(request)
  })
  return contractCall(`ERC20.${functionName}.receipt`, () => waitFor(hash))
}

export const usdcService = {
  balanceOf(owner: Address, token?: Address) {
    return contractCall('ERC20.balanceOf', () =>
      publicClient.readContract({
        address: tokenAddress(token),
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [owner],
      }),
    )
  },

  allowance(owner: Address, spender: Address, token?: Address) {
    return contractCall('ERC20.allowance', () =>
      publicClient.readContract({
        address: tokenAddress(token),
        abi: erc20Abi,
        functionName: 'allowance',
        args: [owner, spender],
      }),
    )
  },

  approve(spender: Address, amount: bigint, token?: Address) {
    return writeErc20('approve', [spender, amount], tokenAddress(token))
  },

  transfer(to: Address, amount: bigint, token?: Address) {
    return writeErc20('transfer', [to, amount], tokenAddress(token))
  },
}
