import { Router, type Request, type Response, type NextFunction } from 'express'
import { BaseError, TransactionReceiptNotFoundError, type Hex } from 'viem'
import { adminToken, publicClient, serverAccount } from '../config.js'
import { errorMessage } from '../logger.js'
import { erc1155Service } from '../services/erc1155Service.js'
import { erc721Service } from '../services/erc721Service.js'
import { gatewayWalletService } from '../services/gatewayWalletService.js'
import {
  assertAddress,
  assertUintParam,
  gamePaymentService,
} from '../services/gamePaymentService.js'
import { npcCharacterService } from '../services/npcCharacterService.js'
import { npcMarketplaceService } from '../services/npcMarketplaceService.js'
import { npcPricingService } from '../services/npcPricingService.js'
import { tbaService } from '../services/tbaService.js'
import { usdcService } from '../services/usdcService.js'
import { bigintToStringDeep } from '../utils/bigintJson.js'
import { parseUint256String } from '../utils/usdc.js'
import { assertBoolean } from '../utils/validation.js'

export const contractRoutes = Router()

function jsonSafe(value: unknown): unknown {
  return bigintToStringDeep(value)
}

function sendJson(res: Response, value: unknown) {
  res.json(jsonSafe(value))
}

function param(req: Request, name: string): string | undefined {
  const value = req.params[name]
  return typeof value === 'string' ? value : undefined
}

function asyncRoute(
  handler: (req: Request, res: Response) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next)
  }
}

function requireWriteAuth(req: Request, res: Response): boolean {
  if (!adminToken) {
    res.status(503).json({ error: 'write contract API disabled; set ADMIN_TOKEN to enable it' })
    return false
  }
  if (req.headers.authorization !== `Bearer ${adminToken}`) {
    res.status(401).json({ error: 'unauthorized' })
    return false
  }
  return true
}

// A TBA execute() reverts in ERC6551 _isValidSigner when the NPC's bound
// paymentWallet is missing or is not the serverAccount. Surface that as a 409
// with an actionable message instead of the generic 502 the error handler would
// otherwise return for a ContractServiceError. Returns true if it handled the error.
function respondSignerRejection(res: Response, err: unknown, tokenId: bigint): boolean {
  const message = err instanceof Error ? err.message : String(err)
  if (!/InvalidSigner|Unauthorized|valid signer|isValidSigner/i.test(message)) return false
  res.status(409).json({
    error: 'npc payment wallet not bound to server account',
    reason:
      `NPC tokenId ${tokenId} has no paymentWallet bound to serverAccount ${serverAccount.address}. ` +
      'Call POST /npc-character/payment-binding to bind first.',
  })
  return true
}

contractRoutes.get('/game/config', asyncRoute(async (_req, res) => {
  sendJson(res, await gamePaymentService.constants())
}))

contractRoutes.get('/game/items/prices', asyncRoute(async (_req, res) => {
  sendJson(res, { items: await gamePaymentService.getPrices() })
}))

contractRoutes.get('/game/items/ids', asyncRoute(async (_req, res) => {
  sendJson(res, { ids: await gamePaymentService.getItemIds() })
}))

contractRoutes.get('/game/item/:id/price', asyncRoute(async (req, res) => {
  const id = assertUintParam(param(req, 'id'), 'id')
  const [buyPrice, sellPrice, circulatingSupply] = await Promise.all([
    gamePaymentService.getBuyPrice(id),
    gamePaymentService.getSellPrice(id),
    gamePaymentService.circulatingSupply(id),
  ])
  sendJson(res, { id, buyPrice, sellPrice, circulatingSupply })
}))

contractRoutes.get('/game/gateway', asyncRoute(async (req, res) => {
  const addr = typeof req.query.addr === 'string' ? assertAddress(req.query.addr, 'addr') : null
  const [
    contractBalance,
    availableBalance,
    withdrawableBalance,
    withdrawingBalance,
    totalBalance,
    withdrawalBlock,
    withdrawalDelay,
    tokenSupported,
    authorized,
  ] = await Promise.all([
    gamePaymentService.getContractBalance(),
    gamePaymentService.gatewayAvailableBalance(),
    gamePaymentService.gatewayWithdrawableBalance(),
    gamePaymentService.gatewayWithdrawingBalance(),
    gamePaymentService.gatewayTotalBalance(),
    gamePaymentService.gatewayWithdrawalBlock(),
    gamePaymentService.gatewayWithdrawalDelay(),
    gamePaymentService.isGatewayTokenSupported(),
    addr ? gamePaymentService.isGatewayAuthorized(addr) : Promise.resolve(null),
  ])
  sendJson(res, {
    contractBalance,
    availableBalance,
    withdrawableBalance,
    withdrawingBalance,
    totalBalance,
    withdrawalBlock,
    withdrawalDelay,
    tokenSupported,
    authorized,
  })
}))

contractRoutes.get('/npc/:tokenId/tba', asyncRoute(async (req, res) => {
  const tokenId = assertUintParam(param(req, 'tokenId'), 'tokenId')
  sendJson(res, { tokenId, tba: await gamePaymentService.npcTba(tokenId) })
}))

contractRoutes.get('/npc/:tokenId/items', asyncRoute(async (req, res) => {
  const tokenId = assertUintParam(param(req, 'tokenId'), 'tokenId')
  sendJson(res, { tokenId, ...(await gamePaymentService.getNpcTbaOwnedItems(tokenId)) })
}))

contractRoutes.get('/npc/:tokenId/items/balances', asyncRoute(async (req, res) => {
  const tokenId = assertUintParam(param(req, 'tokenId'), 'tokenId')
  sendJson(res, { tokenId, ...(await gamePaymentService.getNpcTbaItemBalances(tokenId)) })
}))

contractRoutes.get('/tba/:address/items', asyncRoute(async (req, res) => {
  const tba = assertAddress(req.params.address, 'address')
  sendJson(res, { tba, items: await gamePaymentService.getTbaOwnedItems(tba) })
}))

contractRoutes.get('/tba/:address/items/balances', asyncRoute(async (req, res) => {
  const tba = assertAddress(req.params.address, 'address')
  sendJson(res, { tba, items: await gamePaymentService.getTbaItemBalances(tba) })
}))

contractRoutes.get('/erc1155/:token/balance/:account/:id', asyncRoute(async (req, res) => {
  const token = assertAddress(param(req, 'token'), 'token')
  const account = assertAddress(param(req, 'account'), 'account')
  const id = assertUintParam(param(req, 'id'), 'id')
  sendJson(res, { token, account, id, balance: await erc1155Service.balanceOf(token, account, id) })
}))

contractRoutes.get('/erc1155/:token/approval/:account/:operator', asyncRoute(async (req, res) => {
  const token = assertAddress(param(req, 'token'), 'token')
  const account = assertAddress(param(req, 'account'), 'account')
  const operator = assertAddress(param(req, 'operator'), 'operator')
  sendJson(res, {
    token,
    account,
    operator,
    approved: await erc1155Service.isApprovedForAll(token, account, operator),
  })
}))

contractRoutes.get('/npc-marketplace/listing/:tokenId', asyncRoute(async (req, res) => {
  const tokenId = assertUintParam(param(req, 'tokenId'), 'tokenId')
  sendJson(res, { tokenId, listing: await npcMarketplaceService.getListing(tokenId) })
}))

contractRoutes.get('/npc-marketplace/listings/:tokenId', asyncRoute(async (req, res) => {
  const tokenId = assertUintParam(param(req, 'tokenId'), 'tokenId')
  sendJson(res, { tokenId, listing: await npcMarketplaceService.listings(tokenId) })
}))

contractRoutes.get('/npc-marketplace/config', asyncRoute(async (_req, res) => {
  const [npcCharacter, pricing, usdc] = await Promise.all([
    npcMarketplaceService.npcCharacter(),
    npcMarketplaceService.pricing(),
    npcMarketplaceService.usdc(),
  ])
  sendJson(res, { npcCharacter, pricing, usdc })
}))

contractRoutes.get('/npc-pricing/:tokenId/quote', asyncRoute(async (req, res) => {
  const tokenId = assertUintParam(param(req, 'tokenId'), 'tokenId')
  sendJson(res, { tokenId, ...(await npcPricingService.quoteNpcPrice(tokenId)) })
}))

contractRoutes.get('/npc-pricing/:tokenId/class', asyncRoute(async (req, res) => {
  const tokenId = assertUintParam(param(req, 'tokenId'), 'tokenId')
  sendJson(res, { tokenId, classId: await npcPricingService.getNpcClassId(tokenId) })
}))

contractRoutes.get('/npc-pricing/:tokenId/tba-value', asyncRoute(async (req, res) => {
  const tokenId = assertUintParam(param(req, 'tokenId'), 'tokenId')
  sendJson(res, { tokenId, tbaTotalValue: await npcPricingService.getNpcTbaTotalValue(tokenId) })
}))

contractRoutes.get('/npc-pricing/:tokenId/tba-value-breakdown', asyncRoute(async (req, res) => {
  const tokenId = assertUintParam(param(req, 'tokenId'), 'tokenId')
  sendJson(res, { tokenId, ...(await npcPricingService.getNpcTbaValueBreakdown(tokenId)) })
}))

contractRoutes.get('/npc-pricing/class/:classId/scarcity', asyncRoute(async (req, res) => {
  const classId = assertUintParam(param(req, 'classId'), 'classId')
  sendJson(res, { classId, scarcityMultiplierBps: await npcPricingService.getScarcityMultiplierBps(classId) })
}))

contractRoutes.get('/npc-pricing/class/:classId/market', asyncRoute(async (req, res) => {
  const classId = assertUintParam(param(req, 'classId'), 'classId')
  sendJson(res, { classId, market: await npcPricingService.classMarkets(classId) })
}))

contractRoutes.get('/npc-pricing/config', asyncRoute(async (_req, res) => {
  const [BPS, npcCharacter, usdc, gamePayment] = await Promise.all([
    npcPricingService.BPS(),
    npcPricingService.npcCharacter(),
    npcPricingService.usdc(),
    npcPricingService.gamePayment(),
  ])
  sendJson(res, { BPS, npcCharacter, usdc, gamePayment })
}))

contractRoutes.get('/npc-character/next-token-id', asyncRoute(async (_req, res) => {
  sendJson(res, { nextTokenId: await npcCharacterService.nextTokenId() })
}))

contractRoutes.get('/npc-character/:tokenId', asyncRoute(async (req, res) => {
  const tokenId = assertUintParam(param(req, 'tokenId'), 'tokenId')
  sendJson(res, { tokenId, npc: await npcCharacterService.getNpc(tokenId) })
}))

contractRoutes.get('/npc-character/:tokenId/owner', asyncRoute(async (req, res) => {
  const tokenId = assertUintParam(param(req, 'tokenId'), 'tokenId')
  sendJson(res, { tokenId, owner: await npcCharacterService.ownerOf(tokenId) })
}))

contractRoutes.get('/npc-character/:tokenId/exists', asyncRoute(async (req, res) => {
  const tokenId = assertUintParam(param(req, 'tokenId'), 'tokenId')
  sendJson(res, { tokenId, exists: await npcCharacterService.exists(tokenId) })
}))

contractRoutes.get('/npc-character/:tokenId/payment-binding', asyncRoute(async (req, res) => {
  const tokenId = assertUintParam(param(req, 'tokenId'), 'tokenId')
  sendJson(res, { tokenId, ...(await npcCharacterService.getPaymentBinding(tokenId)) })
}))

contractRoutes.get('/npc-character/:owner/balance', asyncRoute(async (req, res) => {
  const owner = assertAddress(param(req, 'owner'), 'owner')
  sendJson(res, { owner, balance: await npcCharacterService.balanceOf(owner) })
}))

contractRoutes.get('/npc-character/:owner/approval-for-all/:operator', asyncRoute(async (req, res) => {
  const owner = assertAddress(param(req, 'owner'), 'owner')
  const operator = assertAddress(param(req, 'operator'), 'operator')
  sendJson(res, { owner, operator, approved: await erc721Service.isApprovedForAll(owner, operator) })
}))

contractRoutes.get('/npc-character/:tokenId/approved', asyncRoute(async (req, res) => {
  const tokenId = assertUintParam(param(req, 'tokenId'), 'tokenId')
  sendJson(res, { tokenId, approved: await erc721Service.getApproved(tokenId) })
}))

contractRoutes.get('/usdc/:owner/balance', asyncRoute(async (req, res) => {
  const owner = assertAddress(param(req, 'owner'), 'owner')
  sendJson(res, { owner, balance: await usdcService.balanceOf(owner) })
}))

contractRoutes.get('/usdc/:owner/allowance/:spender', asyncRoute(async (req, res) => {
  const owner = assertAddress(param(req, 'owner'), 'owner')
  const spender = assertAddress(param(req, 'spender'), 'spender')
  sendJson(res, { owner, spender, allowance: await usdcService.allowance(owner, spender) })
}))

contractRoutes.get('/gateway/:token/:depositor/balances', asyncRoute(async (req, res) => {
  const token = assertAddress(param(req, 'token'), 'token')
  const depositor = assertAddress(param(req, 'depositor'), 'depositor')
  const [total, available, withdrawing, withdrawable] = await Promise.all([
    gatewayWalletService.totalBalance(token, depositor),
    gatewayWalletService.availableBalance(token, depositor),
    gatewayWalletService.withdrawingBalance(token, depositor),
    gatewayWalletService.withdrawableBalance(token, depositor),
  ])
  sendJson(res, { token, depositor, total, available, withdrawing, withdrawable })
}))

contractRoutes.get('/gateway/withdrawal-delay', asyncRoute(async (_req, res) => {
  sendJson(res, { withdrawalDelay: await gatewayWalletService.withdrawalDelay() })
}))

contractRoutes.get('/gateway/:token/:depositor/withdrawal-block', asyncRoute(async (req, res) => {
  const token = assertAddress(param(req, 'token'), 'token')
  const depositor = assertAddress(param(req, 'depositor'), 'depositor')
  sendJson(res, { token, depositor, withdrawalBlock: await gatewayWalletService.withdrawalBlock(token, depositor) })
}))

contractRoutes.post('/game/item/:id/sell', asyncRoute(async (req, res) => {
  if (!requireWriteAuth(req, res)) return
  const id = assertUintParam(param(req, 'id'), 'id')
  sendJson(res, await gamePaymentService.sellItem(id))
}))

contractRoutes.post('/game/item/:id/buy-x402', asyncRoute(async (req, res) => {
  if (!requireWriteAuth(req, res)) return
  const id = assertUintParam(param(req, 'id'), 'id')
  const body = req.body as Record<string, unknown>
  const to = assertAddress(body.to, 'to')
  const paidAmount = parseUint256String(body.paidAmount, 'paidAmount')
  const maxPriceAllowed = parseUint256String(body.maxPriceAllowed, 'maxPriceAllowed')
  sendJson(res, await gamePaymentService.buyItemX402(to, id, paidAmount, maxPriceAllowed))
}))

contractRoutes.post('/game/mint-random', asyncRoute(async (req, res) => {
  if (!requireWriteAuth(req, res)) return
  const body = req.body as Record<string, unknown>
  const maxPriceAllowed = parseUint256String(body.maxPriceAllowed, 'maxPriceAllowed')
  sendJson(res, await gamePaymentService.mintRandom(maxPriceAllowed))
}))

contractRoutes.post('/game/mint-random-x402', asyncRoute(async (req, res) => {
  if (!requireWriteAuth(req, res)) return
  const body = req.body as Record<string, unknown>
  const to = assertAddress(body.to, 'to')
  sendJson(res, await gamePaymentService.mintRandomX402(to))
}))

// Dumb relay: the client signs a complete tx locally (the signer is the NPC's
// own paymentWallet, generated and held client-side — never serverAccount) and
// hands us the serialized hex. We only broadcast and wait for the receipt; we do
// no nonce/fee/field filling and no persistence. requireWriteAuth guards the
// server's egress without changing the on-chain signing identity.
contractRoutes.post('/tx/send-raw', asyncRoute(async (req, res) => {
  if (!requireWriteAuth(req, res)) return
  const raw = (req.body as Record<string, unknown>).raw
  if (typeof raw !== 'string' || !/^0x([0-9a-fA-F]{2})+$/.test(raw)) {
    res.status(400).json({ error: 'raw must be a 0x-prefixed, even-length hex string' })
    return
  }
  const serializedTransaction = raw as Hex

  let hash: Hex
  try {
    hash = await publicClient.sendRawTransaction({ serializedTransaction })
  } catch (err) {
    const reason = err instanceof BaseError ? err.shortMessage : errorMessage(err)
    res.status(400).json({ error: 'broadcast failed', reason })
    return
  }

  // The tx is on-chain now. If we can't get the receipt in time (or at all),
  // hand the hash back as pending and let the client poll — losing it would be
  // worse than a slightly-degraded response.
  try {
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    sendJson(res, {
      txHash: hash,
      status: receipt.status,
      blockNumber: receipt.blockNumber.toString(),
      gasUsed: receipt.gasUsed.toString(),
    })
  } catch {
    res.json({ txHash: hash, status: 'pending', blockNumber: null, gasUsed: null })
  }
}))

// Read-only receipt lookup for clients that can't speak JSON-RPC directly
// (e.g. Unity WebGL — Nethereum's RpcClient trips IL2CPP stripping on
// RpcParametersJsonConverter, so we expose receipts as plain JSON instead).
// Returns the same shape as /tx/send-raw's success path; status: "pending"
// when the tx isn't on-chain yet, so callers can poll on a fixed cadence.
// We also peek at getTransaction to tell apart "in mempool, just slow" from
// "node doesn't know this hash at all" — the latter is almost always a
// dropped/replaced tx and the client should bail out instead of polling forever.
contractRoutes.get('/tx/receipt/:hash', asyncRoute(async (req, res) => {
  const raw = param(req, 'hash')
  if (!raw || !/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    res.status(400).json({ error: 'hash must be a 0x-prefixed 32-byte hex string' })
    return
  }
  const hash = raw as Hex
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash })
    sendJson(res, {
      txHash: hash,
      status: receipt.status,
      blockNumber: receipt.blockNumber.toString(),
      gasUsed: receipt.gasUsed.toString(),
    })
    return
  } catch (err) {
    if (!(err instanceof TransactionReceiptNotFoundError)) throw err
  }

  // No receipt — is the tx at least in the mempool / known to the node?
  let known = false
  try {
    const tx = await publicClient.getTransaction({ hash })
    known = tx != null
  } catch {
    known = false
  }
  res.json({
    txHash: hash,
    status: known ? 'pending' : 'unknown',
    blockNumber: null,
    gasUsed: null,
  })
}))

contractRoutes.post('/npc-marketplace/list', asyncRoute(async (req, res) => {
  if (!requireWriteAuth(req, res)) return
  const body = req.body as Record<string, unknown>
  const tokenId = parseUint256String(body.tokenId, 'tokenId')
  const minPrice = parseUint256String(body.minPrice, 'minPrice')
  sendJson(res, await npcMarketplaceService.listNpc(tokenId, minPrice))
}))

contractRoutes.post('/npc-marketplace/cancel', asyncRoute(async (req, res) => {
  if (!requireWriteAuth(req, res)) return
  const tokenId = parseUint256String((req.body as Record<string, unknown>).tokenId, 'tokenId')
  sendJson(res, await npcMarketplaceService.cancelListing(tokenId))
}))

contractRoutes.post('/npc-marketplace/clear-stale', asyncRoute(async (req, res) => {
  if (!requireWriteAuth(req, res)) return
  const tokenId = parseUint256String((req.body as Record<string, unknown>).tokenId, 'tokenId')
  sendJson(res, await npcMarketplaceService.clearStaleListing(tokenId))
}))

contractRoutes.post('/npc-marketplace/buy', asyncRoute(async (req, res) => {
  if (!requireWriteAuth(req, res)) return
  const body = req.body as Record<string, unknown>
  const tokenId = parseUint256String(body.tokenId, 'tokenId')
  const maxPrice = parseUint256String(body.maxPrice, 'maxPrice')
  sendJson(res, await npcMarketplaceService.buyNpc(tokenId, maxPrice))
}))

contractRoutes.post('/npc-character/payment-binding', asyncRoute(async (req, res) => {
  if (!requireWriteAuth(req, res)) return
  const body = req.body as Record<string, unknown>
  const tokenId = parseUint256String(body.tokenId, 'tokenId')
  const wallet = assertAddress(body.wallet, 'wallet')
  sendJson(res, await npcCharacterService.bindPaymentWallet(tokenId, wallet))
}))

contractRoutes.post('/npc-character/payment-binding/clear', asyncRoute(async (req, res) => {
  if (!requireWriteAuth(req, res)) return
  const tokenId = parseUint256String((req.body as Record<string, unknown>).tokenId, 'tokenId')
  sendJson(res, await npcCharacterService.clearPaymentWallet(tokenId))
}))

contractRoutes.post('/npc-character/approval-for-all', asyncRoute(async (req, res) => {
  if (!requireWriteAuth(req, res)) return
  const body = req.body as Record<string, unknown>
  const operator = assertAddress(body.operator, 'operator')
  const approved = assertBoolean(body.approved, 'approved')
  sendJson(res, await erc721Service.setApprovalForAll(operator, approved))
}))

contractRoutes.post('/npc-character/approve', asyncRoute(async (req, res) => {
  if (!requireWriteAuth(req, res)) return
  const body = req.body as Record<string, unknown>
  const to = assertAddress(body.to, 'to')
  const tokenId = parseUint256String(body.tokenId, 'tokenId')
  sendJson(res, await erc721Service.approve(to, tokenId))
}))

contractRoutes.post('/usdc/approve', asyncRoute(async (req, res) => {
  if (!requireWriteAuth(req, res)) return
  const body = req.body as Record<string, unknown>
  const spender = assertAddress(body.spender, 'spender')
  const amount = parseUint256String(body.amount, 'amount')
  sendJson(res, await usdcService.approve(spender, amount))
}))

contractRoutes.post('/usdc/transfer', asyncRoute(async (req, res) => {
  if (!requireWriteAuth(req, res)) return
  const body = req.body as Record<string, unknown>
  const to = assertAddress(body.to, 'to')
  const amount = parseUint256String(body.amount, 'amount')
  sendJson(res, await usdcService.transfer(to, amount))
}))

contractRoutes.post('/gateway/deposit', asyncRoute(async (req, res) => {
  if (!requireWriteAuth(req, res)) return
  const body = req.body as Record<string, unknown>
  const token = assertAddress(body.token, 'token')
  const value = parseUint256String(body.value, 'value')
  sendJson(res, await gatewayWalletService.deposit(token, value))
}))

contractRoutes.post('/gateway/deposit-for', asyncRoute(async (req, res) => {
  if (!requireWriteAuth(req, res)) return
  const body = req.body as Record<string, unknown>
  const token = assertAddress(body.token, 'token')
  const depositor = assertAddress(body.depositor, 'depositor')
  const value = parseUint256String(body.value, 'value')
  sendJson(res, await gatewayWalletService.depositFor(token, depositor, value))
}))

contractRoutes.post('/gateway/initiate-withdrawal', asyncRoute(async (req, res) => {
  if (!requireWriteAuth(req, res)) return
  const body = req.body as Record<string, unknown>
  const token = assertAddress(body.token, 'token')
  const value = parseUint256String(body.value, 'value')
  sendJson(res, await gatewayWalletService.initiateWithdrawal(token, value))
}))

contractRoutes.post('/gateway/withdraw', asyncRoute(async (req, res) => {
  if (!requireWriteAuth(req, res)) return
  const token = assertAddress((req.body as Record<string, unknown>).token, 'token')
  sendJson(res, await gatewayWalletService.withdraw(token))
}))

contractRoutes.post('/tba/execute', asyncRoute(async (req, res) => {
  if (!requireWriteAuth(req, res)) return
  const body = req.body as Record<string, unknown>
  const account = assertAddress(body.account, 'account')
  const to = assertAddress(body.to, 'to')
  const value = parseUint256String(body.value ?? '0', 'value')
  const operationRaw = typeof body.operation === 'number' ? body.operation : Number(body.operation ?? 0)
  if (!Number.isInteger(operationRaw) || operationRaw < 0 || operationRaw > 255) {
    throw new Error('operation must be a uint8')
  }
  sendJson(
    res,
    await tbaService.execute({
      account,
      to,
      value,
      data: String(body.data ?? '0x') as `0x${string}`,
      operation: operationRaw,
      extraAllowedTargets: [await gamePaymentService.itemsAddress()],
    }),
  )
}))

contractRoutes.post('/erc1155/approval', asyncRoute(async (req, res) => {
  if (!requireWriteAuth(req, res)) return
  const body = req.body as Record<string, unknown>
  const token = assertAddress(body.token, 'token')
  const operator = assertAddress(body.operator, 'operator')
  if (typeof body.approved !== 'boolean') {
    throw new Error('approved must be a boolean')
  }
  sendJson(res, await erc1155Service.setApprovalForAll(token, operator, body.approved))
}))
