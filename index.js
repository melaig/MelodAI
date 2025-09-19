// hybrid-prices.js
// 依赖：pnpm add ws https-proxy-agent @pythnetwork/hermes-client
import WebSocket from "ws";
import { HttpsProxyAgent } from "https-proxy-agent";
import { HermesClient } from "@pythnetwork/hermes-client";

/** ===================== 配置 ===================== **/

// 需要的交易对（Binance）
const BINANCE_SYMBOLS = ["BTCUSDT", "ETHUSDT"];

// Binance 代理（Clash Mixed）
const PROXY_URL = "http://127.0.0.1:7897";
const agent = new HttpsProxyAgent(PROXY_URL);

// Pyth 端点
const PYTH_ENDPOINT = "https://hermes.pyth.network";

// Pyth priceId（与上面的两种资产对应）
const PYTH_FEEDS = {
    "BTC/USD": "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
    "ETH/USD": "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
};

// Binance -> 友好名称（仅用于打印）
const NAME_BY_BINANCE = {
    BTCUSDT: "BTC/USDT",
    ETHUSDT: "ETH/USDT",
};

// Pyth -> 友好名称（仅用于打印）
const NAME_BY_PYTH_ID = new Map(
    Object.entries(PYTH_FEEDS).map(([name, id]) => [id.toLowerCase().replace(/^0x/, ""), name])
);

// 监控超时：Binance 在该时长内无新tick，则切到 Pyth
const NO_TICK_TIMEOUT_MS = 5000;

// 重连上限（指数退避）
const MAX_BACKOFF_MS = 15000;

/** ===================== 状态 ===================== **/

let activeSource = "binance"; // "binance" | "pyth"
let lastBinanceTick = 0;

let wsBinance = null;  // WebSocket
let esPyth = null;     // EventSource (由 HermesClient 返回)
let binanceBackoff = 0;

const clientPyth = new HermesClient(PYTH_ENDPOINT);

/** ===================== 工具函数 ===================== **/

function now() { return Date.now(); }

function scale(val, expo) {
    if (val == null || expo == null) return null;
    return Number(val) * 10 ** Number(expo);
}

function pythNameById(id) {
    const key = id?.toLowerCase().replace(/^0x/, "");
    return NAME_BY_PYTH_ID.get(key) || (id ? id.slice(0, 10) + "…" : "(未知ID)");
}

function logFrom(source, text) {
    const tag = source === "binance" ? "BINAN" : "PYTH";
    console.log(`[${tag}] ${text}`);
}

/** ===================== Binance 主源 ===================== **/

function startBinance() {
    const streams = BINANCE_SYMBOLS.map(s => s.toLowerCase() + "@bookTicker").join("/");
    const url = `wss://stream.binance.com:443/stream?streams=${streams}`;
    wsBinance = new WebSocket(url, { agent, family: 4 });

    wsBinance.on("open", () => {
        binanceBackoff = 0;
        logFrom("binance", `已连接 (${BINANCE_SYMBOLS.join(", ")})`);
    });

    // 服务器 ping/pong
    wsBinance.on("ping", (data) => {
        wsBinance.pong(data);
    });

    wsBinance.on("message", (raw) => {
        // 某些网关可能会把 PING 作为文本发来（很少见），做个兜底：
        if (raw.toString().includes("PING")) {
            wsBinance.send(raw.toString().replace("PING", "PONG"));
            return;
        }

        let msg;
        try {
            msg = JSON.parse(raw.toString());
        } catch {
            return;
        }

        if (msg.stream && msg.data) {
            const { s: symbol, b: bid, a: ask } = msg.data;
            const bidNum = parseFloat(bid);
            const askNum = parseFloat(ask);
            const mid = (bidNum + askNum) / 2;

            lastBinanceTick = now();

            // 若当前在用 Pyth，且 Binance 已恢复并有数据 → 切回
            if (activeSource !== "binance") {
                activeSource = "binance";
                logFrom("binance", "Binance 已恢复，切回主源。");
            }

            // 仅当主源为 Binance 时输出（避免双源重复刷屏）
            if (activeSource === "binance") {
                logFrom("binance",
                    `[${NAME_BY_BINANCE[symbol] || symbol}] 买一:${bidNum} 卖一:${askNum} 中间价:${mid.toFixed(4)}`
                );
            }
        }
    });

    wsBinance.on("error", (err) => {
        logFrom("binance", `出错: ${err?.message || err}`);
    });

    wsBinance.on("close", () => {
        logFrom("binance", "连接断开。");
        // 若断开，切换到 Pyth
        if (activeSource === "binance") {
            activeSource = "pyth";
            startPyth();
            logFrom("pyth", "已切换到备源 Pyth。");
        }
        // 指数退避重连
        const delay = Math.min(1000 * Math.pow(2, binanceBackoff), MAX_BACKOFF_MS);
        binanceBackoff = Math.min(binanceBackoff + 1, 8);
        setTimeout(() => startBinance(), delay);
    });
}

function stopBinance() {
    try { wsBinance?.close(); } catch { }
    wsBinance = null;
}

/** ===================== Pyth 备源（SSE） ===================== **/

async function startPyth() {
    // 已经有就先停旧的
    stopPyth();

    try {
        esPyth = await clientPyth.getPriceUpdatesStream(Object.values(PYTH_FEEDS));

        esPyth.onmessage = (ev) => {
            if (activeSource !== "pyth") return; // 只在备源激活时输出

            try {
                const pkt = JSON.parse(ev.data);
                if (!pkt?.parsed || !Array.isArray(pkt.parsed)) return;

                for (const upd of pkt.parsed) {
                    const { id, price } = upd;
                    if (!id || !price) continue;

                    const name = pythNameById(id);
                    const px = scale(price.price, price.expo);
                    const conf = scale(price.conf, price.expo);
                    const iso = price.publish_time ? new Date(price.publish_time * 1000).toISOString() : "(无时间戳)";
                    const low = px - conf;
                    const high = px + conf;

                    logFrom("pyth",
                        `[${name}] price: ${px.toFixed(4)} (range: ${low.toFixed(4)} ~ ${high.toFixed(4)}) time: ${iso}`
                    );
                }
            } catch (e) {
                // 忽略单条解析错误
            }
        };

        esPyth.onerror = (err) => {
            logFrom("pyth", `SSE error: ${err?.message || err}`);
        };

        logFrom("pyth", "Pyth SSE 已连接。");
    } catch (e) {
        logFrom("pyth", `连接失败：${e?.message || e}`);
        // 失败时稍后再尝试（不阻塞主流程）
        setTimeout(startPyth, 3000);
    }
}

function stopPyth() {
    try { esPyth?.close?.(); } catch { }
    esPyth = null;
}

/** ===================== 看门狗：无tick切换 ===================== **/

setInterval(() => {
    if (activeSource === "binance") {
        const idle = now() - lastBinanceTick;
        if (lastBinanceTick === 0 || idle > NO_TICK_TIMEOUT_MS) {
            // Binance 无数据超时 → 切到 Pyth
            activeSource = "pyth";
            logFrom("pyth", `Binance ${idle}ms 无tick，切换到 Pyth。`);
            startPyth();
        }
    }
}, 1000);

/** ===================== 启动 ===================== **/

console.log("🔧 启动：主源 Binance，备源 Pyth（自动切换）。");
startBinance();
setTimeout(() => {
    stopBinance();
}, 5000);

// 进程退出时清理
process.on("SIGINT", () => {
    console.log("🧹 退出清理…");
    stopBinance();
    stopPyth();
    process.exit(0);
});
