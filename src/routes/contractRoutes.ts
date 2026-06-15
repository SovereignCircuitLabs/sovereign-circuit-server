import { Router, type Request, type Response, type NextFunction } from 'express'
import { adminToken } from '../config.js'
import { erc1155Service } from '../services/erc1155Service.js'
import {
  assertAddress,
  assertUintParam,
  gamePaymentService,
} from '../services/gamePaymentService.js'
import { tbaService } from '../services/tbaService.js'
import { parseUint256String } from '../utils/usdc.js'

export const contractRoutes = Router()

function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return value.map(jsonSafe)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, jsonSafe(child)]),
    )
  }
  return value
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
  const token = assertAddress(req.params.token, 'token')
  const account = assertAddress(req.params.account, 'account')
  const operator = assertAddress(req.params.operator, 'operator')
  sendJson(res, {
    token,
    account,
    operator,
    approved: await erc1155Service.isApprovedForAll(token, account, operator),
  })
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
