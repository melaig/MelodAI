import WebSocket from "ws";
import { HttpsProxyAgent } from "https-proxy-agent";

// Clash Verge 混合端口
const proxy = "http://127.0.0.1:7897";
const agent = new HttpsProxyAgent(proxy);

// 需要订阅的交易对列表
const symbols = ["ETHUSDT", "BTCUSDT"]; // 可以添加更多，比如 "BNBUSDT"

// 拼接 streams 参数
const streams = symbols.map(s => s.toLowerCase() + "@bookTicker").join("/");
const BINANCE_WS = `wss://stream.binance.com:443/stream?streams=${streams}`;

function connect() {
  const ws = new WebSocket(BINANCE_WS, { agent, family: 4 });

  ws.on("open", () => {
    console.log(`✅ 已通过代理连接 Binance WebSocket (${symbols.join(", ")})`);
  });

  ws.on("message", (raw) => {
    // Binance 的 ping/pong 是 **原始 Buffer**，不是 JSON
    if (raw.toString().includes("PING")) {
      console.log("📩 收到 PING:", raw.toString());

      // 回复 PONG，payload 要和 PING 一样
      ws.send(raw.toString().replace("PING", "PONG"));
      console.log("📤 已回复 PONG");
      return;
    }

    try {
      const msg = JSON.parse(raw.toString());

      // /stream 接口返回的数据格式: { stream: "...", data: {...} }
      if (msg.stream && msg.data) {
        const { s: symbol, b: bid, a: ask } = msg.data;

        const bidNum = parseFloat(bid);
        const askNum = parseFloat(ask);
        const spread = askNum - bidNum;
        const mid = (bidNum + askNum) / 2;

        console.log(
          `[${symbol}] 买一: ${bidNum} 卖一: ${askNum} 中间价: ${mid.toFixed(2)} 点差: ${spread}`
        );
      }
    } catch (err) {
      // 可能是 JSON 解析失败（例如 ping/pong 消息），忽略
      // console.error("⚠️ 解析消息出错:", err);
    }
  });

  ws.on("ping", (data) => {
    // ws 库原生事件：当收到 ping 帧时
    console.log("📩 收到 PING 帧:", data.toString());
    ws.pong(data); // 自动回复 pong
    console.log("📤 已回复 PONG 帧");
  });

  ws.on("pong", (data) => {
    console.log("📩 收到服务器的 PONG:", data.toString());
  });

  ws.on("close", () => {
    console.log("❌ 连接断开，3秒后重连...");
    setTimeout(connect, 3000);
  });

  ws.on("error", (err) => {
    console.error("⚠️ 出错:", err.message);
  });
}

connect();
