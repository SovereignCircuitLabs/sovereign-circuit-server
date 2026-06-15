import type { Address } from 'viem'
import { gatewayWalletAbi } from '../abi/gatewayWalletAbi.js'
import { gatewayWalletAddress, publicClient, serverAccount, walletClient } from '../config.js'
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
  return requiredConfiguredAddress(gatewayWalletAddress, 'GATEWAY_WALLET_ADDRESS')
}

async function read(functionName: string, args: readonly unknown[] = []) {
  return contractCall(`GatewayWallet.${functionName}`, () =>
    publicClient.readContract({
      address: address(),
      abi: gatewayWalletAbi,
      functionName: functionName as never,
      args: args as never,
    }),
  )
}

async function write(functionName: string, args: readonly unknown[]): Promise<TxReceiptView> {
  const hash = await contractCall(`GatewayWallet.${functionName}.simulate`, async () => {
    const { request } = await publicClient.simulateContract({
      address: address(),
      abi: gatewayWalletAbi,
      functionName: functionName as never,
      args: args as never,
      account: serverAccount,
    })
    return walletClient.writeContract(request)
  })
  return contractCall(`GatewayWallet.${functionName}.receipt`, () => waitFor(hash))
}

export const gatewayWalletService = {
  totalBalance(token: Address, depositor: Address) {
    return read('totalBalance', [token, depositor]) as Promise<bigint>
  },
  availableBalance(token: Address, depositor: Address) {
    return read('availableBalance', [token, depositor]) as Promise<bigint>
  },
  withdrawingBalance(token: Address, depositor: Address) {
    return read('withdrawingBalance', [token, depositor]) as Promise<bigint>
  },
  withdrawableBalance(token: Address, depositor: Address) {
    return read('withdrawableBalance', [token, depositor]) as Promise<bigint>
  },
  withdrawalDelay() {
    return read('withdrawalDelay') as Promise<bigint>
  },
  withdrawalBlock(token: Address, depositor: Address) {
    return read('withdrawalBlock', [token, depositor]) as Promise<bigint>
  },
  deposit(token: Address, value: bigint) {
    return write('deposit', [token, value])
  },
  depositFor(token: Address, depositor: Address, value: bigint) {
    return write('depositFor', [token, depositor, value])
  },
  initiateWithdrawal(token: Address, value: bigint) {
    return write('initiateWithdrawal', [token, value])
  },
  withdraw(token: Address) {
    return write('withdraw', [token])
  },
}
