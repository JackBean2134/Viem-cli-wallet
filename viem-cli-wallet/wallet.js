#!/usr/bin/env node
/**
 * 基于 Viem.js 的 Sepolia CLI 钱包
 * ---------------------------------------------------------------
 * 流程（与挑战要求一一对应）：
 *   1. create  生成私钥 / 地址（本地保存到 wallet.json）
 *   2. balance 查询 ETH 余额 + ERC20 代币余额（需先从外部人工转入测试币）
 *   3. build    构造一笔 ERC20 转账的 EIP-1559 交易（只构造，不发送）
 *   4. sign     用生成的账号对交易进行 ECDSA 签名，得到序列化签名交易
 *   5. send     把签名后的原始交易广播到 Sepolia 网络并等待回执
 *
 * 用法：
 *   node wallet.js create
 *   node wallet.js balance
 *   node wallet.js build <接收地址> <金额> [--token 0x代币地址]
 *   node wallet.js sign
 *   node wallet.js send
 */

import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import {
  createPublicClient,
  http,
  erc20Abi,
  encodeFunctionData,
  parseUnits,
  formatUnits,
  formatEther,
} from 'viem'
import { sepolia } from 'viem/chains'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

// ------------------------------------------------------------------
// 基础配置
// ------------------------------------------------------------------
const RPC_URL = process.env.RPC_URL || 'https://ethereum-sepolia.publicnode.com'
const EXPLORER_URL = process.env.EXPLORER_URL || 'https://sepolia.etherscan.io'
const ROOT = process.cwd()
const WALLET_FILE = path.join(ROOT, 'wallet.json')
const TX_FILE = path.join(ROOT, 'tx.json')
const SIGNED_FILE = path.join(ROOT, 'signed-tx.json')

const publicClient = createPublicClient({
  chain: sepolia,
  transport: http(RPC_URL),
})

// ------------------------------------------------------------------
// 工具函数
// ------------------------------------------------------------------
/** JSON 无法序列化 BigInt：保存时转成 "__bigint:十进制字符串"，读取时还原 */
const bigintReplacer = (_key, value) =>
  typeof value === 'bigint' ? `__bigint:${value.toString()}` : value

function reviveBigints(obj) {
  if (Array.isArray(obj)) return obj.map(reviveBigints)
  if (obj !== null && typeof obj === 'object') {
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, reviveBigints(v)]))
  }
  if (typeof obj === 'string' && obj.startsWith('__bigint:')) {
    return BigInt(obj.slice('__bigint:'.length))
  }
  return obj
}

function loadWallet() {
  if (!fs.existsSync(WALLET_FILE)) {
    console.error('❌ 未找到 wallet.json，请先运行: node wallet.js create')
    process.exit(1)
  }
  const { address, privateKey } = JSON.parse(fs.readFileSync(WALLET_FILE, 'utf-8'))
  const account = privateKeyToAccount(privateKey)
  if (account.address !== address) {
    console.error('❌ wallet.json 中的地址与私钥不匹配')
    process.exit(1)
  }
  return account
}

/** 解析命令行参数：位置参数 + --key value 形式 */
function parseArgs(argv) {
  const positional = []
  const options = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true
      options[key] = value
    } else {
      positional.push(arg)
    }
  }
  return { positional, options }
}

async function getTokenMeta(tokenAddress) {
  const [symbol, decimals, name] = await Promise.all([
    publicClient.readContract({ address: tokenAddress, abi: erc20Abi, functionName: 'symbol' }),
    publicClient.readContract({ address: tokenAddress, abi: erc20Abi, functionName: 'decimals' }),
    publicClient.readContract({ address: tokenAddress, abi: erc20Abi, functionName: 'name' }),
  ])
  return { symbol, decimals, name }
}

// ------------------------------------------------------------------
// 1. 生成私钥 / 地址
// ------------------------------------------------------------------
async function cmdCreate() {
  if (fs.existsSync(WALLET_FILE)) {
    console.log('⚠️  wallet.json 已存在，如需重新生成请先删除它。')
    const account = loadWallet()
    console.log('当前账号：', account.address)
    return
  }
  const privateKey = generatePrivateKey()
  const account = privateKeyToAccount(privateKey)

  const data = { address: account.address, privateKey }
  fs.writeFileSync(WALLET_FILE, JSON.stringify(data, null, 2))
  fs.chmodSync(WALLET_FILE, 0o600) // 仅所有者可读，避免私钥泄露

  console.log('✅ 钱包已生成（私钥已保存到 wallet.json，请勿提交到 Git）')
  console.log('  地址 Address :', account.address)
  console.log('  私钥 PrivateKey:', privateKey)
  console.log()
  console.log('👉 下一步：从 Sepolia 水龙头领取测试 ETH，并向本地址人工转入测试 ETH / 测试代币')
  console.log('   领取后运行: node wallet.js balance')
}

// ------------------------------------------------------------------
// 2. 查询余额（ETH + ERC20）
// ------------------------------------------------------------------
async function cmdBalance(options) {
  const account = loadWallet()
  console.log('查询地址:', account.address)
  console.log('网络: Sepolia (chainId =', sepolia.id, ')\n')

  // ETH 原生余额
  const ethRaw = await publicClient.getBalance({ address: account.address })
  console.log(`ETH 余额: ${formatEther(ethRaw)} ETH`)

  // ERC20 代币余额
  const tokenAddress = options.token || process.env.TOKEN_ADDRESS
  if (tokenAddress) {
    const { symbol, decimals, name } = await getTokenMeta(tokenAddress)
    const raw = await publicClient.readContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account.address],
    })
    console.log(`${name} (${symbol}) 余额: ${formatUnits(raw, decimals)} ${symbol}`)
    console.log('代币合约:', tokenAddress)
  } else {
    console.log('（未配置 TOKEN_ADDRESS，跳过代币余额查询）')
  }
  console.log(`\n浏览器查看: ${EXPLORER_URL}/address/${account.address}`)
}

// ------------------------------------------------------------------
// 3. 构造 ERC20 转账的 EIP-1559 交易（仅构造，不签名、不发送）
// ------------------------------------------------------------------
async function cmdBuild(positional, options) {
  const account = loadWallet()
  const [to, amountStr] = positional
  if (!to || !amountStr) {
    console.error('用法: node wallet.js build <接收地址> <金额> [--token 0x代币地址]')
    process.exit(1)
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(to)) {
    console.error('❌ 接收地址格式错误:', to)
    process.exit(1)
  }

  const tokenAddress = options.token || process.env.TOKEN_ADDRESS
  if (!tokenAddress) {
    console.error('❌ 未提供代币地址，请在 .env 配置 TOKEN_ADDRESS 或使用 --token 0x...')
    process.exit(1)
  }

  const { symbol, decimals, name } = await getTokenMeta(tokenAddress)
  const amount = parseUnits(amountStr, decimals)
  console.log(`目标代币: ${name} (${symbol}) @ ${tokenAddress}`)
  console.log(`转账: ${amountStr} ${symbol}  ->  ${to}\n`)

  // 3.1 编码 ERC20 transfer 调用数据: transfer(address to, uint256 amount)
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'transfer',
    args: [to, amount],
  })

  // 3.2 取 nonce（pending 状态，避免并发交易 nonce 冲突）
  const nonce = await publicClient.getTransactionCount({
    address: account.address,
    blockTag: 'pending',
  })

  // 3.3 预估 EIP-1559 费用：maxFeePerGas（最高愿付）、maxPriorityFeePerGas（给矿工的优先费）
  const fees = await publicClient.estimateFeesPerGas()
  let maxFeePerGas = fees.maxFeePerGas
  let maxPriorityFeePerGas = fees.maxPriorityFeePerGas
  if (maxFeePerGas === undefined) {
    // 兜底：节点不返回 EIP-1559 费用时，用 legacy gasPrice
    const gasPrice = await publicClient.getGasPrice()
    maxFeePerGas = gasPrice
    maxPriorityFeePerGas = 1_000_000_000n // 1 gwei（兜底优先费）
  }

  // 3.4 预估执行 gas
  const gas = await publicClient.estimateContractGas({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: 'transfer',
    args: [to, amount],
    account: account.address,
  })

  // 3.5 组装 EIP-1559 交易请求（type = 'eip1559'）
  const txRequest = {
    chainId: sepolia.id,
    type: 'eip1559',
    to: tokenAddress, // ERC20 转账的接收方是代币合约本身
    data, // transfer 的 calldata
    value: 0n, // ERC20 转账不转原生 ETH
    nonce,
    gas,
    maxFeePerGas,
    maxPriorityFeePerGas,
  }

  fs.writeFileSync(TX_FILE, JSON.stringify(txRequest, bigintReplacer, 2))

  console.log('✅ 交易已构造并保存到 tx.json：')
  console.log(JSON.stringify(txRequest, bigintReplacer, 2))
  console.log('\n👉 下一步: node wallet.js sign 进行签名')
}

// ------------------------------------------------------------------
// 4. 签名交易（离线签名，不需要联网）
// ------------------------------------------------------------------
async function cmdSign() {
  if (!fs.existsSync(TX_FILE)) {
    console.error('❌ 未找到 tx.json，请先运行: node wallet.js build')
    process.exit(1)
  }
  const account = loadWallet()
  const txRequest = reviveBigints(JSON.parse(fs.readFileSync(TX_FILE, 'utf-8')))

  // 用账号私钥对交易做 ECDSA 签名，返回序列化后的 RLP 原始交易十六进制
  const serializedTransaction = await account.signTransaction(txRequest)

  fs.writeFileSync(
    SIGNED_FILE,
    JSON.stringify({ serializedTransaction, raw: txRequest }, bigintReplacer, 2),
  )

  console.log('✅ 签名完成，序列化签名交易已保存到 signed-tx.json')
  console.log('serializedTransaction:', serializedTransaction)
  console.log('\n👉 下一步: node wallet.js send 广播交易')
}

// ------------------------------------------------------------------
// 5. 广播交易到 Sepolia 并等待回执
// ------------------------------------------------------------------
async function cmdSend() {
  if (!fs.existsSync(SIGNED_FILE)) {
    console.error('❌ 未找到 signed-tx.json，请先运行: node wallet.js sign')
    process.exit(1)
  }
  const { serializedTransaction } = JSON.parse(fs.readFileSync(SIGNED_FILE, 'utf-8'))

  console.log('📡 正在广播交易到 Sepolia ...')
  const hash = await publicClient.sendRawTransaction({ serializedTransaction })
  console.log('交易哈希:', hash)

  console.log('⏳ 等待区块确认 ...')
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  const status = receipt.status === 'success' ? '✅ 成功' : '❌ 失败'
  console.log(`\n${status}`)
  console.log('区块号 Block   :', receipt.blockNumber.toString())
  console.log('Gas 已使用     :', receipt.gasUsed.toString())
  console.log('浏览器查看     :', `${EXPLORER_URL}/tx/${hash}`)
}

// ------------------------------------------------------------------
// 命令分发
// ------------------------------------------------------------------
const [command, ...rest] = process.argv.slice(2)
const { positional, options } = parseArgs(rest)

const help = `用法:
  node wallet.js create                         # 1. 生成私钥与地址
  node wallet.js balance [--token 0x...]        # 2. 查询 ETH / ERC20 余额
  node wallet.js build <to> <amount> [--token]  # 3. 构造 EIP-1559 ERC20 交易
  node wallet.js sign                           # 4. 签名交易
  node wallet.js send                           # 5. 广播交易并等待回执
`

switch (command) {
  case 'create':
    await cmdCreate()
    break
  case 'balance':
    await cmdBalance(options)
    break
  case 'build':
    await cmdBuild(positional, options)
    break
  case 'sign':
    await cmdSign()
    break
  case 'send':
    await cmdSend()
    break
  default:
    console.log(help)
}
