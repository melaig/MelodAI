// chainlink-price-fallback-fixed.js
// npm i ethers
import { ethers, Contract } from "ethers";

/** 1) 多个 RPC 候选，按顺序尝试 */
const RPCS = [
  process.env.ETH_RPC_URL,                     // 可自定义
  "https://ethereum.publicnode.com",
  "https://rpc.flashbots.net",
  "https://cloudflare-eth.com",
].filter(Boolean);

/** 2) Chainlink Aggregator（主网，地址用全小写避免校验问题） */
const FEEDS = {
  "ETH / USD": "0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419",
  "BTC / USD": "0xf4030086522a5beea4988f8ca5b36dbc97bee88c",
};

/** 3) 最小 ABI */
const ABI = [
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)"
];

/** 创建 Provider：第二个参数直接传 1（主网），不要传第三个 staticNetwork 选项 */
function makeProvider(url) {
  return new ethers.JsonRpcProvider(url, 1);
}

async function tryReadOnce(provider) {
  for (const [name, addr] of Object.entries(FEEDS)) {
    const feed = new Contract(addr, ABI, provider);

    const [decimals, { answer, updatedAt }] = await Promise.all([
      feed.decimals(),
      feed.latestRoundData(),
    ]);

    const price = Number(answer) / 10 ** Number(decimals);
    const iso   = new Date(Number(updatedAt) * 1000).toISOString();
    console.log(`[${name}] ${price} (updatedAt: ${iso})`);
  }
}

async function readWithFallback() {
  let lastErr;
  for (const url of RPCS) {
    try {
      const provider = makeProvider(url);
      // 可选：快速确认链 ID
      const net = await provider.getNetwork();
      if (Number(net.chainId) !== 1) throw new Error(`Connected to chainId=${net.chainId}, not mainnet(1)`);

      await tryReadOnce(provider);
      return;
    } catch (e) {
      lastErr = e;
      console.error(`RPC failed: ${e?.message || e}  -> try next...`);
    }
  }
  throw lastErr;
}

async function poll(intervalMs = 2000) {
  console.log(`🔗 Chainlink feeds on Ethereum mainnet. Polling every ${intervalMs} ms`);
  console.log("RPC candidates:", RPCS.join(" , "));
  try { await readWithFallback(); } catch (e) { console.error("Init read failed:", e); }
  setInterval(async () => {
    try { await readWithFallback(); } catch (e) { console.error("Read failed:", e?.message || e); }
  }, intervalMs);
}

poll(2000);
