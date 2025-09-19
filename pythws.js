import { HermesClient } from "@pythnetwork/hermes-client";

const client = new HermesClient("https://hermes.pyth.network");

// 订阅的 Pyth priceId
const FEEDS = {
  "BTC/USD": "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  "ETH/USD": "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
};

// 生成反向映射：id → 名称
const idToName = new Map(
  Object.entries(FEEDS).map(([name, id]) => [id.toLowerCase().replace(/^0x/, ""), name])
);

function scale(val, expo) {
  if (val == null || expo == null) return null;
  return Number(val) * 10 ** Number(expo);
}

function lookupName(id) {
  if (!id) return "(未知ID)";
  const key = id.toLowerCase().replace(/^0x/, "");
  return idToName.get(key) || id.slice(0, 10) + "…";
}

const es = await client.getPriceUpdatesStream(Object.values(FEEDS));

es.onmessage = (ev) => {
  try {
    const msg = JSON.parse(ev.data);
    if (!msg?.parsed || !Array.isArray(msg.parsed)) return;

    for (const upd of msg.parsed) {
      const { id, price } = upd;
      if (!id || !price) continue;

      const name = lookupName(id);
      const px   = scale(price.price, price.expo);
      const conf = scale(price.conf,  price.expo);
      const iso  = price.publish_time ? new Date(price.publish_time * 1000).toISOString() : "(无时间戳)";

      const low  = px - conf;
      const high = px + conf;

      console.log(
        `[${name}] price: ${px.toFixed(2)} (range: ${low.toFixed(2)} ~ ${high.toFixed(2)}) time: ${iso}`
      );
    }
  } catch (e) {
    console.error("parse error:", e);
  }
};

es.onerror = (err) => {
  console.error("SSE error:", err);
};
