import { getContract } from 'viem'
import type { Address } from 'viem'
import { erc1155Abi } from '../abi/erc1155Abi.js'
import { erc6551AccountAbi } from '../abi/erc6551AccountAbi.js'
import { gamePaymentAbi } from '../abi/gamePaymentAbi.js'
import { gamePaymentAddress, publicClient, walletClient } from '../config.js'

export function gamePaymentContract(address: Address = gamePaymentAddress): unknown {
  return getContract({
    address,
    abi: gamePaymentAbi,
    client: { public: publicClient, wallet: walletClient },
  })
}

export function erc1155Contract(address: Address): unknown {
  return getContract({
    address,
    abi: erc1155Abi,
    client: { public: publicClient, wallet: walletClient },
  })
}

export function erc6551AccountContract(address: Address): unknown {
  return getContract({
    address,
    abi: erc6551AccountAbi,
    client: { public: publicClient, wallet: walletClient },
  })
}
