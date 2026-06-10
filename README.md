# Sovereign Circuit — x402 Seller Server

**Language / 语言 / 語言**:
[English](#english) ｜ [简体中文](#简体中文) ｜ [繁體中文](#繁體中文)

- Unity Client: https://github.com/SovereignCircuitLabs/sovereign-circuit-unity
- Smart Contracts: https://github.com/SovereignCircuitLabs/sovereign-circuit-contracts
- x402 Seller Server (this repo): https://github.com/SovereignCircuitLabs/sovereign-circuit-server

---

## English

### 1. Overview

This repository is the **x402 Seller backend** of the **Arc-Chain-Economy-System**. It is the paywalled API that NPCs (and any x402 buyer) call to purchase ERC-1155 game items with **Circle Gateway nanopayments**.

It exposes a single paywalled endpoint — `GET /item/:id` — and drives the standard **x402 / EIP-3009** flow end to end:

1. **Quote.** On an unpaid request it reads the live item price from `GamePayment.getBuyPrice(id)` and replies **HTTP 402** with a Base64 `PAYMENT-REQUIRED` challenge (Circle Gateway payment requirements).
2. **Verify & settle.** On retry it decodes the buyer's `PAYMENT-SIGNATURE` header (an EIP-3009 `TransferWithAuthorization`), then `verify()` + `settle()` it against the **Circle Gateway** facilitator.
3. **Resolve recipient.** It optionally validates the NPC's `X-NPC-TBA` / `X-NPC-TOKEN-ID` headers on-chain (checking the bound payment wallet via `NpcCharacter.getPaymentBinding` and recomputing the TBA via the ERC-6551 registry) so loot is minted into the correct **NPC TBA**.
4. **Mint.** As the trusted relayer (the **owner** of `GamePayment`) it calls `buyItemX402(to, id, paidAmount, maxPriceAllowed)` to mint the ERC-1155 into the NPC's TBA, and returns the settlement + mint receipt as JSON.

> If `NPC_NFT_ADDRESS` / `ERC6551_IMPLEMENTATION` are not set, TBA validation is disabled and items mint to the payer/operator wallet (legacy fallback).

### 2. Tech Stack

| Layer            | Technology                                                                 |
| ---------------- | -------------------------------------------------------------------------- |
| Runtime          | **Node.js ≥ 18**, TypeScript (run directly via **tsx**, ESM)               |
| HTTP server      | **Express 5**, single paywalled route `GET /item/:id`, port **4021**       |
| Web3 client      | **viem** (public + wallet client, contract read / simulate / write)        |
| Micropayments    | **Circle Gateway** via `@circle-fin/x402-batching` (`BatchFacilitatorClient`, `GatewayClient`) |
| Payment standard | **x402** + **EIP-3009** `TransferWithAuthorization` (EIP-712 typed signatures) |
| Chain            | **Arc Testnet** (EVM, chainId `5042002`), native **USDC** (6 decimals)     |
| On-chain hooks   | `GamePayment` (price + `buyItemX402`), `NpcCharacter` (`getPaymentBinding`), ERC-6551 registry (`account`) |

### 3. Startup

#### 3.1 Prerequisites
- Node.js ≥ 18.
- A deployed **`GamePayment`** contract whose **owner** is this server's key (only the owner may call `buyItemX402`). See the [Smart Contracts repo](https://github.com/SovereignCircuitLabs/sovereign-circuit-contracts).
- Arc Testnet USDC for the client wallet (from the [Circle Faucet](https://faucet.circle.com)).

#### 3.2 Install
```bash
git clone https://github.com/SovereignCircuitLabs/sovereign-circuit-server
cd unity_nanopayments_server
npm install
```

#### 3.3 Configure environment
Generate keys (one-time), then paste the printed values into `.env`:
```bash
npm run setup
# prints CLIENT_PRIVATE_KEY / SERVER_PRIVATE_KEY / SERVER_ADDRESS
```
Copy `.env.example` → `.env` and fill in:
```bash
SERVER_PRIVATE_KEY=0x...        # trusted relayer = owner of GamePayment
SERVER_ADDRESS=0x...

GAME_PAYMENT_ADDRESS=0x...      # deployed GamePayment contract (required)
NPC_NFT_ADDRESS=0x...           # NpcCharacter ERC-721 (enables TBA routing)
ERC6551_REGISTRY=0x...
ERC6551_IMPLEMENTATION=0x...
```

#### 3.4 Fund the Circle Gateway (one-time)
Fund the **CLIENT** address with Arc Testnet USDC via the faucet, then deposit into the Gateway:
```bash
npm run deposit -- 1     # deposits 1 USDC into the Gateway for nanopayments
```

#### 3.5 Run the server
```bash
npm run server
```
Expected log:
```
Server on http://localhost:4021
Paywall: GET /item/:id -> USDC nanopayment (Circle Gateway) + buyItemX402
```
Sanity check (second terminal):
```bash
curl -i http://localhost:4021/item/1     # should return HTTP/1.1 402 Payment Required
```

> Point the **Unity client** at `http://localhost:4021/item/` (`ArcNanopaymentClient.x402ServerBaseUrl`). Always start this server **before** entering the Unity MainScene.

---

## 简体中文

### 1. 项目介绍

本仓库是 **Arc-Chain-Economy-System** 的 **x402 Seller 后端**——一个付费 API,供 NPC(及任意 x402 买家)使用 **Circle Gateway 微支付** 购买 ERC-1155 游戏道具。

它只暴露一个付费端点 `GET /item/:id`,完整驱动标准的 **x402 / EIP-3009** 流程：

1. **报价。** 对未付费请求,从 `GamePayment.getBuyPrice(id)` 读取实时价格,并返回 **HTTP 402** 与 Base64 的 `PAYMENT-REQUIRED` 挑战(Circle Gateway 支付要求)。
2. **验证与结算。** 重试时解码买家的 `PAYMENT-SIGNATURE` 头(EIP-3009 `TransferWithAuthorization`),通过 **Circle Gateway** facilitator 执行 `verify()` + `settle()`。
3. **解析收款方。** 可选地在链上校验 NPC 的 `X-NPC-TBA` / `X-NPC-TOKEN-ID` 头(通过 `NpcCharacter.getPaymentBinding` 检查绑定的支付钱包,并经 ERC-6551 registry 重新推导 TBA),确保道具铸入正确的 **NPC TBA**。
4. **铸造。** 作为受信任的 relayer(即 `GamePayment` 的 **owner**)调用 `buyItemX402(to, id, paidAmount, maxPriceAllowed)`,把 ERC-1155 铸入 NPC TBA,并以 JSON 返回结算 + 铸造回执。

> 若未设置 `NPC_NFT_ADDRESS` / `ERC6551_IMPLEMENTATION`,则关闭 TBA 校验,道具铸入付款方/操作者钱包(legacy 回退)。

### 2. 技术栈

| 层级        | 技术                                                                       |
| ----------- | -------------------------------------------------------------------------- |
| 运行时      | **Node.js ≥ 18**、TypeScript(通过 **tsx** 直接运行,ESM)                  |
| HTTP 服务   | **Express 5**,单一付费路由 `GET /item/:id`,端口 **4021**                 |
| Web3 客户端 | **viem**(public + wallet client,合约 read / simulate / write)           |
| 微支付      | **Circle Gateway**,基于 `@circle-fin/x402-batching`(`BatchFacilitatorClient`、`GatewayClient`) |
| 支付标准    | **x402** + **EIP-3009** `TransferWithAuthorization`(EIP-712 类型化签名)   |
| 区块链      | **Arc Testnet**(EVM,chainId `5042002`),链原生 **USDC**(6 位小数)       |
| 链上调用    | `GamePayment`(价格 + `buyItemX402`)、`NpcCharacter`(`getPaymentBinding`)、ERC-6551 registry(`account`) |

### 3. 启动流程

#### 3.1 前置依赖
- Node.js ≥ 18。
- 一个已部署的 **`GamePayment`** 合约,其 **owner** 即本 server 的私钥(只有 owner 能调用 `buyItemX402`)。见[智能合约仓库](https://github.com/SovereignCircuitLabs/sovereign-circuit-contracts)。
- 客户端钱包持有 Arc Testnet USDC([Circle Faucet](https://faucet.circle.com) 领取)。

#### 3.2 安装
```bash
git clone https://github.com/SovereignCircuitLabs/sovereign-circuit-server
cd unity_nanopayments_server
npm install
```

#### 3.3 配置环境变量
一次性生成密钥,把控制台输出粘贴到 `.env`：
```bash
npm run setup
# 打印 CLIENT_PRIVATE_KEY / SERVER_PRIVATE_KEY / SERVER_ADDRESS
```
复制 `.env.example` → `.env` 并填写：
```bash
SERVER_PRIVATE_KEY=0x...        # 受信任 relayer = GamePayment 的 owner
SERVER_ADDRESS=0x...

GAME_PAYMENT_ADDRESS=0x...      # 已部署的 GamePayment 合约(必填)
NPC_NFT_ADDRESS=0x...           # NpcCharacter ERC-721(启用 TBA 路由)
ERC6551_REGISTRY=0x...
ERC6551_IMPLEMENTATION=0x...
```

#### 3.4 为 Circle Gateway 注资(一次性)
用 faucet 给 **CLIENT** 地址领 Arc Testnet USDC,再充值进 Gateway：
```bash
npm run deposit -- 1     # 向 Gateway 充入 1 USDC 用于微支付
```

#### 3.5 启动服务器
```bash
npm run server
```
正常会打印：
```
Server on http://localhost:4021
Paywall: GET /item/:id -> USDC nanopayment (Circle Gateway) + buyItemX402
```
另开终端验证：
```bash
curl -i http://localhost:4021/item/1     # 应返回 HTTP/1.1 402 Payment Required
```

> 把 **Unity 客户端** 指向 `http://localhost:4021/item/`(`ArcNanopaymentClient.x402ServerBaseUrl`)。进入 Unity MainScene **之前**务必先启动本 server。

---

## 繁體中文

### 1. 專案介紹

本倉庫是 **Arc-Chain-Economy-System** 的 **x402 Seller 後端**——一個付費 API,供 NPC(及任意 x402 買家)使用 **Circle Gateway 微支付** 購買 ERC-1155 遊戲道具。

它只暴露一個付費端點 `GET /item/:id`,完整驅動標準的 **x402 / EIP-3009** 流程：

1. **報價。** 對未付費請求,從 `GamePayment.getBuyPrice(id)` 讀取即時價格,並回傳 **HTTP 402** 與 Base64 的 `PAYMENT-REQUIRED` 挑戰(Circle Gateway 支付要求)。
2. **驗證與結算。** 重試時解碼買家的 `PAYMENT-SIGNATURE` 標頭(EIP-3009 `TransferWithAuthorization`),透過 **Circle Gateway** facilitator 執行 `verify()` + `settle()`。
3. **解析收款方。** 可選地在鏈上校驗 NPC 的 `X-NPC-TBA` / `X-NPC-TOKEN-ID` 標頭(透過 `NpcCharacter.getPaymentBinding` 檢查綁定的支付錢包,並經 ERC-6551 registry 重新推導 TBA),確保道具鑄入正確的 **NPC TBA**。
4. **鑄造。** 作為受信任的 relayer(即 `GamePayment` 的 **owner**)呼叫 `buyItemX402(to, id, paidAmount, maxPriceAllowed)`,把 ERC-1155 鑄入 NPC TBA,並以 JSON 回傳結算 + 鑄造回執。

> 若未設定 `NPC_NFT_ADDRESS` / `ERC6551_IMPLEMENTATION`,則關閉 TBA 校驗,道具鑄入付款方/操作者錢包(legacy 回退)。

### 2. 技術堆疊

| 層級        | 技術                                                                       |
| ----------- | -------------------------------------------------------------------------- |
| 執行環境    | **Node.js ≥ 18**、TypeScript(透過 **tsx** 直接執行,ESM)                  |
| HTTP 服務   | **Express 5**,單一付費路由 `GET /item/:id`,連接埠 **4021**               |
| Web3 客戶端 | **viem**(public + wallet client,合約 read / simulate / write)           |
| 微支付      | **Circle Gateway**,基於 `@circle-fin/x402-batching`(`BatchFacilitatorClient`、`GatewayClient`) |
| 支付標準    | **x402** + **EIP-3009** `TransferWithAuthorization`(EIP-712 類型化簽名)   |
| 區塊鏈      | **Arc Testnet**(EVM,chainId `5042002`),鏈原生 **USDC**(6 位小數)       |
| 鏈上呼叫    | `GamePayment`(價格 + `buyItemX402`)、`NpcCharacter`(`getPaymentBinding`)、ERC-6551 registry(`account`) |

### 3. 啟動流程

#### 3.1 前置需求
- Node.js ≥ 18。
- 一個已部署的 **`GamePayment`** 合約,其 **owner** 即本 server 的私鑰(只有 owner 能呼叫 `buyItemX402`)。見[智能合約倉庫](https://github.com/SovereignCircuitLabs/sovereign-circuit-contracts)。
- 客戶端錢包持有 Arc Testnet USDC([Circle Faucet](https://faucet.circle.com) 領取)。

#### 3.2 安裝
```bash
git clone https://github.com/SovereignCircuitLabs/sovereign-circuit-server
cd unity_nanopayments_server
npm install
```

#### 3.3 設定環境變數
一次性產生密鑰,把控制台輸出貼到 `.env`：
```bash
npm run setup
# 印出 CLIENT_PRIVATE_KEY / SERVER_PRIVATE_KEY / SERVER_ADDRESS
```
複製 `.env.example` → `.env` 並填寫：
```bash
SERVER_PRIVATE_KEY=0x...        # 受信任 relayer = GamePayment 的 owner
SERVER_ADDRESS=0x...

GAME_PAYMENT_ADDRESS=0x...      # 已部署的 GamePayment 合約(必填)
NPC_NFT_ADDRESS=0x...           # NpcCharacter ERC-721(啟用 TBA 路由)
ERC6551_REGISTRY=0x...
ERC6551_IMPLEMENTATION=0x...
```

#### 3.4 為 Circle Gateway 注資(一次性)
用 faucet 給 **CLIENT** 位址領 Arc Testnet USDC,再充值進 Gateway：
```bash
npm run deposit -- 1     # 向 Gateway 充入 1 USDC 用於微支付
```

#### 3.5 啟動伺服器
```bash
npm run server
```
正常會印出：
```
Server on http://localhost:4021
Paywall: GET /item/:id -> USDC nanopayment (Circle Gateway) + buyItemX402
```
另開終端驗證：
```bash
curl -i http://localhost:4021/item/1     # 應回傳 HTTP/1.1 402 Payment Required
```

> 把 **Unity 客戶端** 指向 `http://localhost:4021/item/`(`ArcNanopaymentClient.x402ServerBaseUrl`)。進入 Unity MainScene **之前**務必先啟動本 server。

---

## License

See [`LICENSE`](./LICENSE).
