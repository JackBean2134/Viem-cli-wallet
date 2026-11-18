# Viem CLI Wallet（Sepolia）

基于 [Viem.js](https://viem.sh) 的命令行钱包，完整走一遍「**生成账号 → 查询余额 → 构造 EIP-1559 交易 → 签名 → 广播上链**」的流程，对应登链挑战「使用 Viem 构建一个 CLI 钱包」。

## 目录结构

```
viem-cli-wallet/
├── wallet.js        # 全部命令逻辑
── package.json
├── .env.example     # 环境变量模板
└── README.md
```

运行后会在目录下生成（不要提交到 Git）：

- `wallet.json` —— 本地保存的私钥与地址（权限已设为 600）
- `tx.json` —— build 阶段构造好的交易请求
- `signed-tx.json` —— sign 阶段产出的序列化签名交易

## 1. 安装

```bash
cd viem-cli-wallet
npm install
cp .env.example .env
```

编辑 `.env`：

- `RPC_URL`：Sepolia 节点。公共节点 `https://rpc.sepolia.org` 可直接用；国内网络不稳时建议填自己的 Alchemy / Infura Sepolia RPC。
- `TOKEN_ADDRESS`：你要转账的 ERC20 测试代币合约地址（build 时也可用 `--token` 临时指定）。

## 2. 四步操作

### ① 生成私钥 / 地址

```bash
npm run create
# 等价: node wallet.js create
```

内部调用 Viem：

```js
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

const privateKey = generatePrivateKey()        // 密码学安全随机 32 字节
const account = privateKeyToAccount(privateKey) // 由私钥派生地址（keccak256(pubkey)[12:]）
```

生成后去 Sepolia 水龙头领测试 ETH（如 [sepolia-faucet.pk910.de](https://sepolia-faucet.pk910.de/)、[Alchemy Faucet](https://www.alchemy.com/faucets/ethereum-sepolia)），人工转入本地址；测试代币同样需要先弄到余额。

### ② 查询余额

```bash
npm run balance
```

- ETH：`publicClient.getBalance({ address })` → `formatEther`
- ERC20：`readContract` 调 `balanceOf(address)`，再用 `decimals` + `formatUnits` 格式化

### ③ 构造 ERC20 转账的 EIP-1559 交易

```bash
npm run build -- 0x接收地址 100
# 或指定代币: node wallet.js build 0x... 100 --token 0x代币合约地址
```

脚本内部依次做：

1. `encodeFunctionData` 编码 `transfer(address to, uint256 amount)` 的 calldata；
2. `getTransactionCount({ blockTag: 'pending' })` 取 nonce；
3. `estimateFeesPerGas()` 取 EIP-1559 的 `maxFeePerGas` / `maxPriorityFeePerGas`；
4. `estimateContractGas` 预估 gas；
5. 组装 `type: 'eip1559'` 交易请求存到 `tx.json`。

> 注意：ERC20 转账的 `to` 是**代币合约地址**，`value = 0`，转账金额放在 calldata 里。

### ④ 签名（离线）

```bash
npm run sign
```

```js
const serializedTransaction = await account.signTransaction(txRequest)
```

Viem 用私钥对交易哈希做 ECDSA（EIP-1559 的 v 字段是 yParity），输出 RLP 序列化的签名交易十六进制。这一步不联网，可在断网机器上完成。

### ⑤ 广播上链

```bash
npm run send
```

- `publicClient.sendRawTransaction({ serializedTransaction })` 广播，拿回交易哈希；
- `waitForTransactionReceipt({ hash })` 等待打包，打印状态、gas 用量和 Etherscan 链接。

## 关键知识点

| 概念 | 在代码中的位置 |
| --- | --- |
| 私钥 → 地址派生 | `privateKeyToAccount` |
| EIP-1559 字段 | `type: 'eip1559'`、`maxFeePerGas`、`maxPriorityFeePerGas` |
| ERC20 calldata 编码 | `encodeFunctionData({ functionName: 'transfer' })` |
| 离线签名 | `account.signTransaction` |
| 广播原始交易 | `sendRawTransaction` |

## 安全提醒

`wallet.json` 只用于测试网练习，**切勿**把里面的私钥用于主网或任何真实资产；`wallet.json`、`signed-tx.json` 已在本地生成，记得写进 `.gitignore`。
