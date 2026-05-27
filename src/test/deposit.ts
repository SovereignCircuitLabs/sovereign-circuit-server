import 'dotenv/config'
import { GatewayClient } from '@circle-fin/x402-batching/client'

const privateKey = process.env.CLIENT_PRIVATE_KEY as `0x${string}`
if (!privateKey) { console.error('CLIENT_PRIVATE_KEY not set'); process.exit(1) }

const amount = process.argv[2]
if (!amount) {
  console.error('Usage: npm run deposit -- <amount>')
  console.error('Example: npm run deposit -- 1')
  process.exit(1)
}

const gateway = new GatewayClient({
  chain: 'arcTestnet',
  privateKey,
})

console.log(`Client address: ${gateway.address}`)

// Check wallet balance before depositing
const balancesBefore = await gateway.getBalances()
console.log(`\nWallet USDC: ${balancesBefore.wallet.formatted}`)
console.log(`Gateway available: ${balancesBefore.gateway.formattedAvailable}\n`)

console.log(`Depositing ${amount} USDC into Gateway...`)
const result = await gateway.deposit(amount)
console.log('✅ Deposit complete!')
console.log(`Amount: ${result.formattedAmount} USDC`)
console.log(`Deposit tx: ${result.depositTxHash}`)
if (result.approvalTxHash) {
  console.log(`Approval tx: ${result.approvalTxHash}`)
}

// Check updated balances
const balancesAfter = await gateway.getBalances()
console.log(`\nUpdated Gateway available: ${balancesAfter.gateway.formattedAvailable}`)
