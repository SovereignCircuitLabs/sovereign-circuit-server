# Sovereign Circuit — x402 Seller & On-Chain Gateway Server

**Language / 语言 / 語言**:
[English](#english) ｜ [简体中文](#简体中文) ｜ [繁體中文](#繁體中文)

**Links / 链接 / 連結**:

- 🌐 Website / 项目官网 / 專案官網: https://sovereign-circuit.com/
- 📺 Video intro / 视频介绍 / 影片介紹: https://www.youtube.com/watch?v=CTXvgje_fYE
- Unity Client: https://github.com/SovereignCircuitLabs/sovereign-circuit-unity
- Smart Contracts: https://github.com/SovereignCircuitLabs/sovereign-circuit-contracts
- x402 Seller Server (this repo): https://github.com/SovereignCircuitLabs/sovereign-circuit-server

---

## English

### 1. Overview

This repository is the **backend** of the **Arc-Chain-Economy-System**. It plays two roles:

1. **x402 Seller** — the paywalled API that NPCs (and any x402 buyer) call to purchase ERC-1155 game items with **Circle Gateway nanopayments**.
2. **On-chain gateway for the Unity WebGL client** — a plain REST/JSON facade over every contract in the system, plus a raw-transaction relay.

> **Why so much on-chain logic lives here.** The game now ships to **Unity WebGL**, where the IL2CPP build strips reflection-heavy code and there is no reliable in-browser JSON-RPC stack (Nethereum's `RpcClient` trips IL2CPP stripping on its JSON converters). So instead of talking to the chain from the client, the server exposes **all** contract reads and writes as ordinary HTTP+JSON endpoints, and offers a **dumb relay** for transactions the client must sign itself. The WebGL client never speaks JSON-RPC, never deals with ABIs, and never holds the operator key — it just calls REST.

#### 1.1 The x402 paywall — `GET /item/:id`

The single paywalled endpoint drives the standard **x402 / EIP-3009** flow end to end:

1. **Quote.** On an unpaid request it reads the live item price from `GamePayment.getBuyPrice(id)` and replies **HTTP 402** with a Base64 `PAYMENT-REQUIRED` challenge (Circle Gateway payment requirements).
2. **Verify & settle.** On retry it decodes the buyer's `PAYMENT-SIGNATURE` header (an EIP-3009 `TransferWithAuthorization`), then `verify()` + `settle()` it against the **Circle Gateway** facilitator.
3. **Resolve recipient.** It optionally validates the NPC's `X-NPC-TBA` / `X-NPC-TOKEN-ID` headers on-chain (checking the bound payment wallet via `NpcCharacter.getPaymentBinding` and recomputing the TBA via the ERC-6551 registry) so loot is minted into the correct **NPC TBA**.
4. **Mint.** As the trusted relayer (the **owner** of `GamePayment`) it calls `buyItemX402(to, id, paidAmount, maxPriceAllowed)` to mint the ERC-1155 into the NPC's TBA. Mint is attempted **inline** first; if it doesn't finish quickly it is handed to a background worker with retries and refund compensation, and the client polls `GET /order/:orderId` for the final state.

> If `NPC_NFT_ADDRESS` / `ERC6551_IMPLEMENTATION` are not set, TBA validation is disabled and items mint to the payer/operator wallet (legacy fallback).

#### 1.2 The contract API — `/api/*`

Everything the WebGL client needs to read or do on-chain is exposed under `/api` (see [§4](#4-contract-api-api)):

- **Reads (`GET`, public)** — prices, item ids, gateway balances, NPC data, TBA inventories, marketplace listings, dynamic pricing/scarcity quotes, ERC-1155/ERC-721/USDC balances & approvals, etc. All BigInt values are serialized as decimal strings.
- **Writes (`POST`, guarded by `ADMIN_TOKEN`)** — operator-signed transactions such as `buyItemX402`, marketplace list/cancel/buy, NPC payment-wallet binding, USDC/ERC approvals & transfers, Gateway deposits/withdrawals, and TBA `execute`.
- **Transaction relay** — `POST /api/tx/send-raw` broadcasts a transaction the **client signed locally** (e.g. with the NPC's own payment wallet, which never leaves the client), and `GET /api/tx/receipt/:hash` lets a client that can't speak JSON-RPC poll for the receipt.

### 2. Tech Stack

| Layer            | Technology                                                                 |
| ---------------- | -------------------------------------------------------------------------- |
| Runtime          | **Node.js ≥ 18**, TypeScript (run directly via **tsx**, ESM)               |
| HTTP server      | **Express 5**, port **4021** — paywall `GET /item/:id` + contract API `/api/*` |
| Web3 client      | **viem** (public + wallet client, contract read / simulate / write)        |
| Persistence      | **SQLite** (`better-sqlite3`) order store for the mint/refund pipeline      |
| Micropayments    | **Circle Gateway** via `@circle-fin/x402-batching` (`BatchFacilitatorClient`, `GatewayClient`) |
| Payment standard | **x402** + **EIP-3009** `TransferWithAuthorization` (EIP-712 typed signatures) |
| Chain            | **Arc Testnet** (EVM, chainId `5042002`), native **USDC** (6 decimals)     |
| Contracts        | `GamePayment`, `NpcCharacter`, `NpcMarketplace`, `NpcPricing`, `GatewayWallet`, ERC-1155 / ERC-721 / ERC-6551 TBA, USDC |
| Deployment       | **Dockerfile** (single-stage, `tsx`) + **Railway** (`railway.json`), SQLite on a mounted volume |

### 3. Startup

#### 3.1 Prerequisites
- Node.js ≥ 18.
- A deployed **`GamePayment`** contract whose **owner** is this server's key (only the owner may call `buyItemX402`). See the [Smart Contracts repo](https://github.com/SovereignCircuitLabs/sovereign-circuit-contracts).

#### 3.2 Install
```bash
git clone https://github.com/SovereignCircuitLabs/sovereign-circuit-server
cd unity_nanopayments_server
npm install
```

#### 3.3 Configure environment
Copy `.env.example` → `.env` and fill in:
```bash
SERVER_PRIVATE_KEY=0x...        # trusted relayer = owner of GamePayment
SERVER_ADDRESS=0x...
ARC_RPC_URL=                    # optional; defaults to the Arc Testnet RPC

GAME_PAYMENT_ADDRESS=0x...      # deployed GamePayment contract (required)

# Optional contracts — enable the matching /api groups when set
NPC_NFT_ADDRESS=0x...           # NpcCharacter ERC-721 (also enables TBA routing)
NPC_MARKETPLACE_ADDRESS=
NPC_PRICING_ADDRESS=
USDC_ADDRESS=                   # defaults to the chain's native USDC
GATEWAY_WALLET_ADDRESS=
ERC6551_REGISTRY=0x...
ERC6551_IMPLEMENTATION=0x...
# ERC6551_SALT defaults to 0x000...0

# Bearer token guarding ALL write (POST) endpoints + GET /admin/orders.
# Leave empty to disable every write route.
ADMIN_TOKEN=
```

> **`SERVER_PRIVATE_KEY` / `SERVER_ADDRESS` is the wallet that deployed `GamePayment`** (i.e. its `owner`) — only that key may call `buyItemX402` and other operator writes. The buyer side (and each NPC's own payment wallet) lives entirely in the Unity client; the server never holds buyer keys.

#### 3.4 Run the server
```bash
npm run server
```
Sanity check (second terminal):
```bash
curl -i http://localhost:4021/item/1            # should return HTTP/1.1 402 Payment Required
curl -s http://localhost:4021/api/game/items/ids # contract API: managed item ids
```

> Point the **Unity client** at `http://localhost:4021` (`ArcNanopaymentClient.x402ServerBaseUrl` for the paywall; the same host serves `/api/*`). Always start this server **before** entering the Unity MainScene.

#### 3.5 Docker / Railway
A single-stage `Dockerfile` runs the server with `tsx` (dev deps stay installed; `better-sqlite3` is compiled inside the Linux image). `ORDER_DB_PATH` defaults to `/data/orders.db` so the SQLite file lives on a mounted volume. `railway.json` builds from the Dockerfile and restarts on failure.
```bash
docker build -t sovereign-circuit-server .
docker run -p 4021:4021 --env-file .env -v "$PWD/data:/data" sovereign-circuit-server
```

#### 3.6 Dev-only scripts (ignore for normal use)
`src/setup.ts` (`npm run setup`) and everything under `src/test/` (`npm run client`, `npm run deposit`) are **leftover utilities from development/testing** and are **not part of the runtime flow**. The buyer side is now handled by the Unity client, so these scripts can be ignored or removed.

### 4. Contract API (`/api`)

All on-chain operations the WebGL client needs are exposed here as JSON. BigInt values are returned as decimal strings. **GET** endpoints are public reads; **POST** endpoints write on-chain and require `Authorization: Bearer <ADMIN_TOKEN>` (a write route returns `503` if `ADMIN_TOKEN` is unset, `401` if the token is wrong).

#### 4.1 Reads (`GET`)

| Endpoint | Returns |
| -------- | ------- |
| `/api/game/config` | GamePayment constants |
| `/api/game/items/prices` · `/api/game/items/ids` | All item prices / managed ids |
| `/api/game/item/:id/price` | Buy/sell price + circulating supply |
| `/api/game/gateway?addr=` | Contract & Gateway balances, withdrawal delay, token-supported, (optional) authorization |
| `/api/npc/:tokenId/tba` | NPC's ERC-6551 TBA address |
| `/api/npc/:tokenId/items` · `/api/npc/:tokenId/items/balances` | Items owned by an NPC's TBA |
| `/api/tba/:address/items` · `/api/tba/:address/items/balances` | Items owned by any TBA address |
| `/api/erc1155/:token/balance/:account/:id` · `/api/erc1155/:token/approval/:account/:operator` | ERC-1155 balance / approval-for-all |
| `/api/npc-marketplace/listing/:tokenId` · `/listings/:tokenId` · `/config` | Marketplace listing + config |
| `/api/npc-pricing/:tokenId/quote` · `/class` · `/tba-value` · `/tba-value-breakdown` | Dynamic NPC pricing & TBA valuation |
| `/api/npc-pricing/class/:classId/scarcity` · `/market` · `/api/npc-pricing/config` | Scarcity / class market / config |
| `/api/npc-character/next-token-id` · `/:tokenId` · `/:tokenId/owner` · `/:tokenId/exists` · `/:tokenId/payment-binding` | NPC metadata, owner, payment binding |
| `/api/npc-character/:owner/balance` · `/:owner/approval-for-all/:operator` · `/:tokenId/approved` | ERC-721 balance / approvals |
| `/api/usdc/:owner/balance` · `/:owner/allowance/:spender` | USDC balance / allowance |
| `/api/gateway/:token/:depositor/balances` · `/withdrawal-delay` · `/:token/:depositor/withdrawal-block` | GatewayWallet balances & withdrawal timing |
| `/api/tx/receipt/:hash` | Transaction receipt (`status: pending \| unknown` while not yet on-chain) |

#### 4.2 Writes (`POST`, require `ADMIN_TOKEN`)

| Endpoint | Action |
| -------- | ------ |
| `/api/game/item/:id/sell` | `sellItem` |
| `/api/game/item/:id/buy-x402` `{ to, paidAmount, maxPriceAllowed }` | `buyItemX402` mint |
| `/api/game/mint-random` · `/api/game/mint-random-x402` | Random-item mints |
| `/api/npc-marketplace/list` · `/cancel` · `/clear-stale` · `/buy` | NPC marketplace ops |
| `/api/npc-character/payment-binding` `{ tokenId, wallet }` · `/payment-binding/clear` | Bind / clear an NPC's payment wallet |
| `/api/npc-character/approval-for-all` · `/approve` | ERC-721 approvals |
| `/api/usdc/approve` · `/usdc/transfer` | USDC approve / transfer |
| `/api/gateway/deposit` · `/deposit-for` · `/initiate-withdrawal` · `/withdraw` | GatewayWallet deposits / withdrawals |
| `/api/tba/execute` `{ account, to, value, data, operation }` | Execute a call from an NPC's TBA |
| `/api/erc1155/approval` | ERC-1155 approval-for-all |

#### 4.3 Transaction relay (for client-signed txs)

- **`POST /api/tx/send-raw`** `{ raw: "0x..." }` — broadcasts a fully serialized transaction the **client signed locally** (e.g. with the NPC's own payment wallet, which never leaves the client). The server does **no** nonce/fee/field filling and no persistence — it only broadcasts and waits for the receipt, returning `{ txHash, status, blockNumber, gasUsed }` (or `status: pending` if the receipt is slow). `ADMIN_TOKEN` guards egress without changing the on-chain signing identity.
- **`GET /api/tx/receipt/:hash`** — receipt lookup for clients that can't speak JSON-RPC; `status` is `pending` when the tx is in the mempool and `unknown` when the node has never seen it (likely dropped/replaced), so callers know when to stop polling.

### 5. Order pipeline & operator endpoints

The paywall persists each purchase as an order in SQLite and drives it through a state machine (`PENDING_PAYMENT → SETTLED → MINTING → COMPLETED`, with `MINT_FAILED → REFUNDING → REFUNDED` compensation). Retry policy is tunable via `MINT_MAX_ATTEMPTS`, `REFUND_MAX_ATTEMPTS`, `RETRY_BASE_MS`, `RETRY_CAP_MS`, `RETRY_TICK_MS`.

- `GET /order/:orderId` — clients poll this until a terminal state.
- `GET /admin/orders?state=...` — operator visibility into stuck orders (requires `ADMIN_TOKEN`).

---

## 简体中文

### 1. 项目介绍

本仓库是 **Arc-Chain-Economy-System** 的 **后端**,承担两个角色：

1. **x402 Seller**——付费 API,供 NPC(及任意 x402 买家)使用 **Circle Gateway 微支付** 购买 ERC-1155 游戏道具。
2. **Unity WebGL 客户端的链上网关**——把系统内所有合约封装成普通的 REST/JSON 接口,并提供原始交易转发。

> **为什么大量链上逻辑都放在这里。** 游戏现在发布到 **Unity WebGL**:IL2CPP 构建会裁剪大量依赖反射的代码,浏览器里也没有可靠的 JSON-RPC 栈(Nethereum 的 `RpcClient` 会因其 JSON 转换器触发 IL2CPP 裁剪而失效)。因此,链上交互不再由客户端直接完成,而是由服务器把 **所有** 合约读/写都暴露为普通的 HTTP+JSON 端点,并为必须由客户端自己签名的交易提供 **纯转发(dumb relay)**。WebGL 客户端从不直接讲 JSON-RPC、不处理 ABI、也不持有操作者私钥——它只调用 REST。

#### 1.1 x402 付费墙 —— `GET /item/:id`

唯一的付费端点完整驱动标准的 **x402 / EIP-3009** 流程：

1. **报价。** 对未付费请求,从 `GamePayment.getBuyPrice(id)` 读取实时价格,并返回 **HTTP 402** 与 Base64 的 `PAYMENT-REQUIRED` 挑战(Circle Gateway 支付要求)。
2. **验证与结算。** 重试时解码买家的 `PAYMENT-SIGNATURE` 头(EIP-3009 `TransferWithAuthorization`),通过 **Circle Gateway** facilitator 执行 `verify()` + `settle()`。
3. **解析收款方。** 可选地在链上校验 NPC 的 `X-NPC-TBA` / `X-NPC-TOKEN-ID` 头(通过 `NpcCharacter.getPaymentBinding` 检查绑定的支付钱包,并经 ERC-6551 registry 重新推导 TBA),确保道具铸入正确的 **NPC TBA**。
4. **铸造。** 作为受信任的 relayer(即 `GamePayment` 的 **owner**)调用 `buyItemX402(to, id, paidAmount, maxPriceAllowed)`,把 ERC-1155 铸入 NPC TBA。铸造先 **同步(inline)** 尝试;若未能很快完成,则交给带重试与退款补偿的后台 worker,客户端轮询 `GET /order/:orderId` 获取最终状态。

> 若未设置 `NPC_NFT_ADDRESS` / `ERC6551_IMPLEMENTATION`,则关闭 TBA 校验,道具铸入付款方/操作者钱包(legacy 回退)。

#### 1.2 合约 API —— `/api/*`

WebGL 客户端需要的所有链上读写都暴露在 `/api` 下(见[§4](#4-合约-api-api)):

- **读取(`GET`,公开)**——价格、道具 id、Gateway 余额、NPC 数据、TBA 库存、市场挂单、动态定价/稀缺度报价、ERC-1155/ERC-721/USDC 余额与授权等。所有 BigInt 均序列化为十进制字符串。
- **写入(`POST`,由 `ADMIN_TOKEN` 保护)**——操作者签名的交易,如 `buyItemX402`、市场挂单/取消/购买、NPC 支付钱包绑定、USDC/ERC 授权与转账、Gateway 存取款、TBA `execute`。
- **交易转发**——`POST /api/tx/send-raw` 广播由 **客户端本地签名** 的交易(例如用 NPC 自己的、永不离开客户端的支付钱包),`GET /api/tx/receipt/:hash` 则让无法直接讲 JSON-RPC 的客户端轮询回执。

### 2. 技术栈

| 层级        | 技术                                                                       |
| ----------- | -------------------------------------------------------------------------- |
| 运行时      | **Node.js ≥ 18**、TypeScript(通过 **tsx** 直接运行,ESM)                  |
| HTTP 服务   | **Express 5**,端口 **4021**——付费墙 `GET /item/:id` + 合约 API `/api/*`   |
| Web3 客户端 | **viem**(public + wallet client,合约 read / simulate / write)           |
| 持久化      | **SQLite**(`better-sqlite3`),用于铸造/退款流水的订单库                   |
| 微支付      | **Circle Gateway**,基于 `@circle-fin/x402-batching`(`BatchFacilitatorClient`、`GatewayClient`) |
| 支付标准    | **x402** + **EIP-3009** `TransferWithAuthorization`(EIP-712 类型化签名)   |
| 区块链      | **Arc Testnet**(EVM,chainId `5042002`),链原生 **USDC**(6 位小数)       |
| 合约        | `GamePayment`、`NpcCharacter`、`NpcMarketplace`、`NpcPricing`、`GatewayWallet`、ERC-1155 / ERC-721 / ERC-6551 TBA、USDC |
| 部署        | **Dockerfile**(单阶段,`tsx`)+ **Railway**(`railway.json`),SQLite 挂载到数据卷 |

### 3. 启动流程

#### 3.1 前置依赖
- Node.js ≥ 18。
- 一个已部署的 **`GamePayment`** 合约,其 **owner** 即本 server 的私钥(只有 owner 能调用 `buyItemX402`)。见[智能合约仓库](https://github.com/SovereignCircuitLabs/sovereign-circuit-contracts)。

#### 3.2 安装
```bash
git clone https://github.com/SovereignCircuitLabs/sovereign-circuit-server
cd unity_nanopayments_server
npm install
```

#### 3.3 配置环境变量
复制 `.env.example` → `.env` 并填写：
```bash
SERVER_PRIVATE_KEY=0x...        # 受信任 relayer = GamePayment 的 owner
SERVER_ADDRESS=0x...
ARC_RPC_URL=                    # 可选；默认使用 Arc Testnet RPC

GAME_PAYMENT_ADDRESS=0x...      # 已部署的 GamePayment 合约(必填)

# 可选合约——设置后启用对应的 /api 分组
NPC_NFT_ADDRESS=0x...           # NpcCharacter ERC-721(同时启用 TBA 路由)
NPC_MARKETPLACE_ADDRESS=
NPC_PRICING_ADDRESS=
USDC_ADDRESS=                   # 默认使用链原生 USDC
GATEWAY_WALLET_ADDRESS=
ERC6551_REGISTRY=0x...
ERC6551_IMPLEMENTATION=0x...
# ERC6551_SALT 默认 0x000...0

# 保护所有写入(POST)端点 + GET /admin/orders 的 Bearer Token。
# 留空则禁用全部写入路由。
ADMIN_TOKEN=
```

> **`SERVER_PRIVATE_KEY` / `SERVER_ADDRESS` 就是部署 `GamePayment` 合约的钱包**(即其 `owner`)——只有该私钥能调用 `buyItemX402` 及其他操作者写入。买家逻辑(以及每个 NPC 自己的支付钱包)完全在 Unity 客户端内,server 端从不持有买家私钥。

#### 3.4 启动服务器
```bash
npm run server
```
另开终端验证：
```bash
curl -i http://localhost:4021/item/1            # 应返回 HTTP/1.1 402 Payment Required
curl -s http://localhost:4021/api/game/items/ids # 合约 API：受管道具 id
```

> 把 **Unity 客户端** 指向 `http://localhost:4021`(付费墙用 `ArcNanopaymentClient.x402ServerBaseUrl`;同一主机同时提供 `/api/*`)。进入 Unity MainScene **之前**务必先启动本 server。

#### 3.5 Docker / Railway
单阶段 `Dockerfile` 用 `tsx` 运行服务器(保留 dev 依赖;`better-sqlite3` 在 Linux 镜像内编译)。`ORDER_DB_PATH` 默认 `/data/orders.db`,使 SQLite 文件落在挂载卷上。`railway.json` 基于 Dockerfile 构建并在失败时重启。
```bash
docker build -t sovereign-circuit-server .
docker run -p 4021:4021 --env-file .env -v "$PWD/data:/data" sovereign-circuit-server
```

#### 3.6 仅供开发的脚本(正常使用可忽略)
`src/setup.ts`(`npm run setup`)与 `src/test/` 下的全部脚本(`npm run client`、`npm run deposit`)都是**开发/测试阶段遗留的工具**,**不属于运行时流程**。买家逻辑现在均由 Unity 客户端处理,因此这些脚本可忽略或删除。

### 4. 合约 API(`/api`)

WebGL 客户端需要的所有链上操作都以 JSON 暴露于此。BigInt 以十进制字符串返回。**GET** 为公开读取;**POST** 为链上写入,需 `Authorization: Bearer <ADMIN_TOKEN>`(未设置 `ADMIN_TOKEN` 时写入路由返回 `503`,Token 错误返回 `401`)。

#### 4.1 读取(`GET`)

| 端点 | 返回 |
| ---- | ---- |
| `/api/game/config` | GamePayment 常量 |
| `/api/game/items/prices` · `/api/game/items/ids` | 全部道具价格 / 受管 id |
| `/api/game/item/:id/price` | 买/卖价 + 流通量 |
| `/api/game/gateway?addr=` | 合约与 Gateway 余额、提现延迟、token 支持、(可选)授权状态 |
| `/api/npc/:tokenId/tba` | NPC 的 ERC-6551 TBA 地址 |
| `/api/npc/:tokenId/items` · `/api/npc/:tokenId/items/balances` | NPC TBA 持有的道具 |
| `/api/tba/:address/items` · `/api/tba/:address/items/balances` | 任意 TBA 地址持有的道具 |
| `/api/erc1155/:token/balance/:account/:id` · `/api/erc1155/:token/approval/:account/:operator` | ERC-1155 余额 / 全量授权 |
| `/api/npc-marketplace/listing/:tokenId` · `/listings/:tokenId` · `/config` | 市场挂单 + 配置 |
| `/api/npc-pricing/:tokenId/quote` · `/class` · `/tba-value` · `/tba-value-breakdown` | 动态 NPC 定价与 TBA 估值 |
| `/api/npc-pricing/class/:classId/scarcity` · `/market` · `/api/npc-pricing/config` | 稀缺度 / 类别市场 / 配置 |
| `/api/npc-character/next-token-id` · `/:tokenId` · `/:tokenId/owner` · `/:tokenId/exists` · `/:tokenId/payment-binding` | NPC 元数据、持有者、支付绑定 |
| `/api/npc-character/:owner/balance` · `/:owner/approval-for-all/:operator` · `/:tokenId/approved` | ERC-721 余额 / 授权 |
| `/api/usdc/:owner/balance` · `/:owner/allowance/:spender` | USDC 余额 / 额度 |
| `/api/gateway/:token/:depositor/balances` · `/withdrawal-delay` · `/:token/:depositor/withdrawal-block` | GatewayWallet 余额与提现计时 |
| `/api/tx/receipt/:hash` | 交易回执(尚未上链时 `status: pending \| unknown`) |

#### 4.2 写入(`POST`,需 `ADMIN_TOKEN`)

| 端点 | 动作 |
| ---- | ---- |
| `/api/game/item/:id/sell` | `sellItem` |
| `/api/game/item/:id/buy-x402` `{ to, paidAmount, maxPriceAllowed }` | `buyItemX402` 铸造 |
| `/api/game/mint-random` · `/api/game/mint-random-x402` | 随机道具铸造 |
| `/api/npc-marketplace/list` · `/cancel` · `/clear-stale` · `/buy` | NPC 市场操作 |
| `/api/npc-character/payment-binding` `{ tokenId, wallet }` · `/payment-binding/clear` | 绑定 / 清除 NPC 支付钱包 |
| `/api/npc-character/approval-for-all` · `/approve` | ERC-721 授权 |
| `/api/usdc/approve` · `/usdc/transfer` | USDC 授权 / 转账 |
| `/api/gateway/deposit` · `/deposit-for` · `/initiate-withdrawal` · `/withdraw` | GatewayWallet 存款 / 提款 |
| `/api/tba/execute` `{ account, to, value, data, operation }` | 从 NPC 的 TBA 发起调用 |
| `/api/erc1155/approval` | ERC-1155 全量授权 |

#### 4.3 交易转发(用于客户端签名的交易)

- **`POST /api/tx/send-raw`** `{ raw: "0x..." }`——广播由 **客户端本地签名** 的完整序列化交易(例如用 NPC 自己的、永不离开客户端的支付钱包)。服务器 **不做** nonce/手续费/字段填充,也不持久化——只广播并等待回执,返回 `{ txHash, status, blockNumber, gasUsed }`(回执慢时返回 `status: pending`)。`ADMIN_TOKEN` 仅保护出口,不改变链上签名身份。
- **`GET /api/tx/receipt/:hash`**——为无法直接讲 JSON-RPC 的客户端提供回执查询;交易在内存池中时 `status` 为 `pending`,节点从未见过时为 `unknown`(很可能已被丢弃/替换),客户端据此判断何时停止轮询。

### 5. 订单流水与操作者端点

付费墙将每笔购买作为订单持久化到 SQLite,并驱动其状态机(`PENDING_PAYMENT → SETTLED → MINTING → COMPLETED`,带 `MINT_FAILED → REFUNDING → REFUNDED` 补偿)。重试策略可通过 `MINT_MAX_ATTEMPTS`、`REFUND_MAX_ATTEMPTS`、`RETRY_BASE_MS`、`RETRY_CAP_MS`、`RETRY_TICK_MS` 调整。

- `GET /order/:orderId`——客户端轮询直到终态。
- `GET /admin/orders?state=...`——操作者查看卡住的订单(需 `ADMIN_TOKEN`)。

---

## 繁體中文

### 1. 專案介紹

本倉庫是 **Arc-Chain-Economy-System** 的 **後端**,承擔兩個角色：

1. **x402 Seller**——付費 API,供 NPC(及任意 x402 買家)使用 **Circle Gateway 微支付** 購買 ERC-1155 遊戲道具。
2. **Unity WebGL 客戶端的鏈上閘道**——把系統內所有合約封裝成普通的 REST/JSON 介面,並提供原始交易轉發。

> **為什麼大量鏈上邏輯都放在這裡。** 遊戲現在發佈到 **Unity WebGL**:IL2CPP 建置會裁剪大量依賴反射的程式碼,瀏覽器裡也沒有可靠的 JSON-RPC 堆疊(Nethereum 的 `RpcClient` 會因其 JSON 轉換器觸發 IL2CPP 裁剪而失效)。因此,鏈上互動不再由客戶端直接完成,而是由伺服器把 **所有** 合約讀/寫都暴露為普通的 HTTP+JSON 端點,並為必須由客戶端自己簽名的交易提供 **純轉發(dumb relay)**。WebGL 客戶端從不直接講 JSON-RPC、不處理 ABI、也不持有操作者私鑰——它只呼叫 REST。

#### 1.1 x402 付費牆 —— `GET /item/:id`

唯一的付費端點完整驅動標準的 **x402 / EIP-3009** 流程：

1. **報價。** 對未付費請求,從 `GamePayment.getBuyPrice(id)` 讀取即時價格,並回傳 **HTTP 402** 與 Base64 的 `PAYMENT-REQUIRED` 挑戰(Circle Gateway 支付要求)。
2. **驗證與結算。** 重試時解碼買家的 `PAYMENT-SIGNATURE` 標頭(EIP-3009 `TransferWithAuthorization`),透過 **Circle Gateway** facilitator 執行 `verify()` + `settle()`。
3. **解析收款方。** 可選地在鏈上校驗 NPC 的 `X-NPC-TBA` / `X-NPC-TOKEN-ID` 標頭(透過 `NpcCharacter.getPaymentBinding` 檢查綁定的支付錢包,並經 ERC-6551 registry 重新推導 TBA),確保道具鑄入正確的 **NPC TBA**。
4. **鑄造。** 作為受信任的 relayer(即 `GamePayment` 的 **owner**)呼叫 `buyItemX402(to, id, paidAmount, maxPriceAllowed)`,把 ERC-1155 鑄入 NPC TBA。鑄造先 **同步(inline)** 嘗試;若未能很快完成,則交給帶重試與退款補償的背景 worker,客戶端輪詢 `GET /order/:orderId` 取得最終狀態。

> 若未設定 `NPC_NFT_ADDRESS` / `ERC6551_IMPLEMENTATION`,則關閉 TBA 校驗,道具鑄入付款方/操作者錢包(legacy 回退)。

#### 1.2 合約 API —— `/api/*`

WebGL 客戶端需要的所有鏈上讀寫都暴露在 `/api` 下(見[§4](#4-合約-api-api-1)):

- **讀取(`GET`,公開)**——價格、道具 id、Gateway 餘額、NPC 資料、TBA 庫存、市場掛單、動態定價/稀缺度報價、ERC-1155/ERC-721/USDC 餘額與授權等。所有 BigInt 均序列化為十進位字串。
- **寫入(`POST`,由 `ADMIN_TOKEN` 保護)**——操作者簽名的交易,如 `buyItemX402`、市場掛單/取消/購買、NPC 支付錢包綁定、USDC/ERC 授權與轉帳、Gateway 存取款、TBA `execute`。
- **交易轉發**——`POST /api/tx/send-raw` 廣播由 **客戶端本地簽名** 的交易(例如用 NPC 自己的、永不離開客戶端的支付錢包),`GET /api/tx/receipt/:hash` 則讓無法直接講 JSON-RPC 的客戶端輪詢回執。

### 2. 技術堆疊

| 層級        | 技術                                                                       |
| ----------- | -------------------------------------------------------------------------- |
| 執行環境    | **Node.js ≥ 18**、TypeScript(透過 **tsx** 直接執行,ESM)                  |
| HTTP 服務   | **Express 5**,連接埠 **4021**——付費牆 `GET /item/:id` + 合約 API `/api/*` |
| Web3 客戶端 | **viem**(public + wallet client,合約 read / simulate / write)           |
| 持久化      | **SQLite**(`better-sqlite3`),用於鑄造/退款流水的訂單庫                   |
| 微支付      | **Circle Gateway**,基於 `@circle-fin/x402-batching`(`BatchFacilitatorClient`、`GatewayClient`) |
| 支付標準    | **x402** + **EIP-3009** `TransferWithAuthorization`(EIP-712 類型化簽名)   |
| 區塊鏈      | **Arc Testnet**(EVM,chainId `5042002`),鏈原生 **USDC**(6 位小數)       |
| 合約        | `GamePayment`、`NpcCharacter`、`NpcMarketplace`、`NpcPricing`、`GatewayWallet`、ERC-1155 / ERC-721 / ERC-6551 TBA、USDC |
| 部署        | **Dockerfile**(單階段,`tsx`)+ **Railway**(`railway.json`),SQLite 掛載到資料卷 |

### 3. 啟動流程

#### 3.1 前置需求
- Node.js ≥ 18。
- 一個已部署的 **`GamePayment`** 合約,其 **owner** 即本 server 的私鑰(只有 owner 能呼叫 `buyItemX402`)。見[智能合約倉庫](https://github.com/SovereignCircuitLabs/sovereign-circuit-contracts)。

#### 3.2 安裝
```bash
git clone https://github.com/SovereignCircuitLabs/sovereign-circuit-server
cd unity_nanopayments_server
npm install
```

#### 3.3 設定環境變數
複製 `.env.example` → `.env` 並填寫：
```bash
SERVER_PRIVATE_KEY=0x...        # 受信任 relayer = GamePayment 的 owner
SERVER_ADDRESS=0x...
ARC_RPC_URL=                    # 可選；預設使用 Arc Testnet RPC

GAME_PAYMENT_ADDRESS=0x...      # 已部署的 GamePayment 合約(必填)

# 可選合約——設定後啟用對應的 /api 分組
NPC_NFT_ADDRESS=0x...           # NpcCharacter ERC-721(同時啟用 TBA 路由)
NPC_MARKETPLACE_ADDRESS=
NPC_PRICING_ADDRESS=
USDC_ADDRESS=                   # 預設使用鏈原生 USDC
GATEWAY_WALLET_ADDRESS=
ERC6551_REGISTRY=0x...
ERC6551_IMPLEMENTATION=0x...
# ERC6551_SALT 預設 0x000...0

# 保護所有寫入(POST)端點 + GET /admin/orders 的 Bearer Token。
# 留空則停用全部寫入路由。
ADMIN_TOKEN=
```

> **`SERVER_PRIVATE_KEY` / `SERVER_ADDRESS` 就是部署 `GamePayment` 合約的錢包**(即其 `owner`)——只有該私鑰能呼叫 `buyItemX402` 及其他操作者寫入。買家邏輯(以及每個 NPC 自己的支付錢包)完全在 Unity 客戶端內,server 端從不持有買家私鑰。

#### 3.4 啟動伺服器
```bash
npm run server
```
另開終端驗證：
```bash
curl -i http://localhost:4021/item/1            # 應回傳 HTTP/1.1 402 Payment Required
curl -s http://localhost:4021/api/game/items/ids # 合約 API：受管道具 id
```

> 把 **Unity 客戶端** 指向 `http://localhost:4021`(付費牆用 `ArcNanopaymentClient.x402ServerBaseUrl`;同一主機同時提供 `/api/*`)。進入 Unity MainScene **之前**務必先啟動本 server。

#### 3.5 Docker / Railway
單階段 `Dockerfile` 用 `tsx` 執行伺服器(保留 dev 相依;`better-sqlite3` 在 Linux 映像內編譯)。`ORDER_DB_PATH` 預設 `/data/orders.db`,使 SQLite 檔案落在掛載卷上。`railway.json` 基於 Dockerfile 建置並在失敗時重啟。
```bash
docker build -t sovereign-circuit-server .
docker run -p 4021:4021 --env-file .env -v "$PWD/data:/data" sovereign-circuit-server
```

#### 3.6 僅供開發的腳本(正常使用可忽略)
`src/setup.ts`(`npm run setup`)與 `src/test/` 下的全部腳本(`npm run client`、`npm run deposit`)都是**開發/測試階段遺留的工具**,**不屬於執行時流程**。買家邏輯現在均由 Unity 客戶端處理,因此這些腳本可忽略或刪除。

### 4. 合約 API(`/api`)

WebGL 客戶端需要的所有鏈上操作都以 JSON 暴露於此。BigInt 以十進位字串回傳。**GET** 為公開讀取;**POST** 為鏈上寫入,需 `Authorization: Bearer <ADMIN_TOKEN>`(未設定 `ADMIN_TOKEN` 時寫入路由回傳 `503`,Token 錯誤回傳 `401`)。

#### 4.1 讀取(`GET`)

| 端點 | 回傳 |
| ---- | ---- |
| `/api/game/config` | GamePayment 常數 |
| `/api/game/items/prices` · `/api/game/items/ids` | 全部道具價格 / 受管 id |
| `/api/game/item/:id/price` | 買/賣價 + 流通量 |
| `/api/game/gateway?addr=` | 合約與 Gateway 餘額、提領延遲、token 支援、(可選)授權狀態 |
| `/api/npc/:tokenId/tba` | NPC 的 ERC-6551 TBA 位址 |
| `/api/npc/:tokenId/items` · `/api/npc/:tokenId/items/balances` | NPC TBA 持有的道具 |
| `/api/tba/:address/items` · `/api/tba/:address/items/balances` | 任意 TBA 位址持有的道具 |
| `/api/erc1155/:token/balance/:account/:id` · `/api/erc1155/:token/approval/:account/:operator` | ERC-1155 餘額 / 全量授權 |
| `/api/npc-marketplace/listing/:tokenId` · `/listings/:tokenId` · `/config` | 市場掛單 + 設定 |
| `/api/npc-pricing/:tokenId/quote` · `/class` · `/tba-value` · `/tba-value-breakdown` | 動態 NPC 定價與 TBA 估值 |
| `/api/npc-pricing/class/:classId/scarcity` · `/market` · `/api/npc-pricing/config` | 稀缺度 / 類別市場 / 設定 |
| `/api/npc-character/next-token-id` · `/:tokenId` · `/:tokenId/owner` · `/:tokenId/exists` · `/:tokenId/payment-binding` | NPC 中繼資料、持有者、支付綁定 |
| `/api/npc-character/:owner/balance` · `/:owner/approval-for-all/:operator` · `/:tokenId/approved` | ERC-721 餘額 / 授權 |
| `/api/usdc/:owner/balance` · `/:owner/allowance/:spender` | USDC 餘額 / 額度 |
| `/api/gateway/:token/:depositor/balances` · `/withdrawal-delay` · `/:token/:depositor/withdrawal-block` | GatewayWallet 餘額與提領計時 |
| `/api/tx/receipt/:hash` | 交易回執(尚未上鏈時 `status: pending \| unknown`) |

#### 4.2 寫入(`POST`,需 `ADMIN_TOKEN`)

| 端點 | 動作 |
| ---- | ---- |
| `/api/game/item/:id/sell` | `sellItem` |
| `/api/game/item/:id/buy-x402` `{ to, paidAmount, maxPriceAllowed }` | `buyItemX402` 鑄造 |
| `/api/game/mint-random` · `/api/game/mint-random-x402` | 隨機道具鑄造 |
| `/api/npc-marketplace/list` · `/cancel` · `/clear-stale` · `/buy` | NPC 市場操作 |
| `/api/npc-character/payment-binding` `{ tokenId, wallet }` · `/payment-binding/clear` | 綁定 / 清除 NPC 支付錢包 |
| `/api/npc-character/approval-for-all` · `/approve` | ERC-721 授權 |
| `/api/usdc/approve` · `/usdc/transfer` | USDC 授權 / 轉帳 |
| `/api/gateway/deposit` · `/deposit-for` · `/initiate-withdrawal` · `/withdraw` | GatewayWallet 存款 / 提款 |
| `/api/tba/execute` `{ account, to, value, data, operation }` | 從 NPC 的 TBA 發起呼叫 |
| `/api/erc1155/approval` | ERC-1155 全量授權 |

#### 4.3 交易轉發(用於客戶端簽名的交易)

- **`POST /api/tx/send-raw`** `{ raw: "0x..." }`——廣播由 **客戶端本地簽名** 的完整序列化交易(例如用 NPC 自己的、永不離開客戶端的支付錢包)。伺服器 **不做** nonce/手續費/欄位填充,也不持久化——只廣播並等待回執,回傳 `{ txHash, status, blockNumber, gasUsed }`(回執慢時回傳 `status: pending`)。`ADMIN_TOKEN` 僅保護出口,不改變鏈上簽名身份。
- **`GET /api/tx/receipt/:hash`**——為無法直接講 JSON-RPC 的客戶端提供回執查詢;交易在記憶體池中時 `status` 為 `pending`,節點從未見過時為 `unknown`(很可能已被丟棄/替換),客戶端據此判斷何時停止輪詢。

### 5. 訂單流水與操作者端點

付費牆將每筆購買作為訂單持久化到 SQLite,並驅動其狀態機(`PENDING_PAYMENT → SETTLED → MINTING → COMPLETED`,帶 `MINT_FAILED → REFUNDING → REFUNDED` 補償)。重試策略可透過 `MINT_MAX_ATTEMPTS`、`REFUND_MAX_ATTEMPTS`、`RETRY_BASE_MS`、`RETRY_CAP_MS`、`RETRY_TICK_MS` 調整。

- `GET /order/:orderId`——客戶端輪詢直到終態。
- `GET /admin/orders?state=...`——操作者查看卡住的訂單(需 `ADMIN_TOKEN`)。

---

## License

See [`LICENSE`](./LICENSE).
</content>
</invoke>
