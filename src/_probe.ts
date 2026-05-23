// Circle Gateway x402 transfer inspector.
//
// Usage:
//   npx tsx src/_probe.ts                       list recent transfers from this wallet
//   npx tsx src/_probe.ts <uuid>                look up one transfer by id (tx=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)
//   npx tsx src/_probe.ts --to 0x...            filter by recipient
//   npx tsx src/_probe.ts --from 0x...          filter by sender
//   npx tsx src/_probe.ts --status received|batched|confirmed|completed|failed
//   npx tsx src/_probe.ts --limit 20            page size (default 10)
//   npx tsx src/_probe.ts --seller              alias for `--to $SERVER_ADDRESS`
//
// Status flow: received -> batched -> confirmed -> completed (or -> failed).
// The on-chain tx hash only appears once status reaches `batched` or later.

import 'dotenv/config'
import type { Hex } from 'viem'
import { GatewayClient, type SearchTransfersParams, type TransferResponse } from '@circle-fin/x402-batching/client'

type Status = NonNullable<SearchTransfersParams['status']>

interface CliOpts {
  id?: string
  from?: Hex
  to?: Hex
  status?: Status
  limit?: number
}

function parseArgs(): CliOpts {
  const args = process.argv.slice(2)
  const opts: CliOpts = {}
  const seller = process.env.SERVER_ADDRESS as Hex | undefined
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--to') opts.to = args[++i] as Hex
    else if (a === '--from') opts.from = args[++i] as Hex
    else if (a === '--status') opts.status = args[++i] as Status
    else if (a === '--limit') opts.limit = Number(args[++i])
    else if (a === '--seller') {
      if (!seller) throw new Error('SERVER_ADDRESS not set in .env, cannot use --seller')
      opts.to = seller
    } else if (a && !a.startsWith('--')) opts.id = a
  }
  return opts
}

function fmtUsdc(atomic: string) {
  const n = BigInt(atomic)
  const whole = n / 1_000_000n
  const frac = (n % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : `${whole}`
}

function fmtTransfer(t: TransferResponse) {
  const arrow = `${t.fromAddress.slice(0, 10)}…  →  ${t.toAddress.slice(0, 10)}…`
  const cross = t.sendingNetwork === t.recipientNetwork ? t.sendingNetwork : `${t.sendingNetwork} → ${t.recipientNetwork}`
  const onChain = (t.transactionHash ?? t.sendingTxHash ?? t.txHash) as string | undefined
  const lines = [
    `  ${t.id}    status=${t.status}`,
    `    ${arrow}    ${fmtUsdc(t.amount)} USDC    ${cross}`,
    `    created=${t.createdAt}    updated=${t.updatedAt}`,
  ]
  if (onChain) lines.push(`    on-chain: ${onChain}`)
  return lines.join('\n')
}

const opts = parseArgs()
const pk = process.env.CLIENT_PRIVATE_KEY as Hex | undefined
if (!pk) {
  console.error('CLIENT_PRIVATE_KEY not set')
  process.exit(1)
}
const gw = new GatewayClient({ chain: 'arcTestnet', privateKey: pk })

if (opts.id) {
  try {
    const t = await gw.getTransferById(opts.id)
    console.log(fmtTransfer(t))
    console.log('\nFull payload:')
    console.log(JSON.stringify(t, null, 2))
  } catch (e) {
    console.error('lookup failed:', (e as Error).message)
    process.exit(1)
  }
} else {
  const wallet = gw.address as Hex
  console.log(`Wallet:                   ${wallet}`)
  if (process.env.SERVER_ADDRESS) console.log(`Seller (SERVER_ADDRESS):  ${process.env.SERVER_ADDRESS}`)
  console.log()

  // Default: transfers sent FROM this wallet, unless the user filtered explicitly.
  const filters: SearchTransfersParams = {
    pageSize: opts.limit ?? 10,
    ...(opts.from ? { from: opts.from } : {}),
    ...(opts.to ? { to: opts.to } : {}),
    ...(opts.status ? { status: opts.status } : {}),
    ...(!opts.from && !opts.to ? { from: wallet } : {}),
  }

  console.log(`Searching ${JSON.stringify(filters)}\n`)
  const r = await gw.searchTransfers(filters)
  if (r.transfers.length === 0) console.log('  (no transfers)')
  else for (const t of r.transfers) console.log(fmtTransfer(t))

  const b = await gw.getBalances()
  console.log('\n--- balances ---')
  console.log(`  Wallet USDC:       ${b.wallet.formatted}`)
  console.log(`  Gateway available: ${b.gateway.formattedAvailable}`)
  console.log(`  Gateway total:     ${b.gateway.formattedTotal}`)
}
