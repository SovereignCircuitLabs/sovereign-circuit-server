import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

const clientKey = generatePrivateKey()
const serverKey = generatePrivateKey()

console.log('\n=== Add to .env ===')
console.log(`CLIENT_PRIVATE_KEY=${clientKey}`)
console.log(`SERVER_PRIVATE_KEY=${serverKey}`)
console.log(`SERVER_ADDRESS=${privateKeyToAccount(serverKey).address}`)
console.log('\n=== Fund the CLIENT address with testnet USDC ===')
console.log(`Client address : ${privateKeyToAccount(clientKey).address}`)
console.log(`Server address : ${privateKeyToAccount(serverKey).address}`)
console.log('\nFaucet: https://faucet.circle.com  →  Arc Testnet + USDC')
console.log('\n=== Then deposit USDC into Gateway ===')
console.log('npm run deposit -- 1    (deposits 1 USDC into Gateway for nanopayments)\n')
