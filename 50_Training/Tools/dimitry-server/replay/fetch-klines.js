/* ============================================================
   KLINE FETCHER + CACHE          Vault Intelligence v4 · Step 1
   Zero dependencies (node https only).

   Runs on the LAPTOP, where the exchange APIs are reachable.
   Writes a plain JSON cache that replay.js reads, so the replay
   itself is deterministic and re-runnable offline.

   Cache: 50_Training/Tools/klines/<ASSET>_<TF>.json
          { asset, tf, source, fetchedAt, candles:[{t,o,h,l,c,v}] }
   ============================================================ */
"use strict";
const https = require("https");
const fs    = require("fs");
const path  = require("path");

const CACHE = path.resolve(__dirname, "..", "..", "klines");

/* Binance interval codes */
const TF_CODE = { "5m":"5m", "15m":"15m", "30m":"30m", "1H":"1h", "4H":"4h", "1D":"1d", "1W":"1w" };

function get(url){
  return new Promise((resolve, reject) => {
    https.get(url, { headers:{ "User-Agent":"dimitry/1.0" } }, res => {
      let b = "";
      res.on("data", d => b += d);
      res.on("end", () => {
        if(res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${b.slice(0,160)}`));
        try { resolve(JSON.parse(b)); } catch(e){ reject(e); }
      });
    }).on("error", reject);
  });
}

/** Binance klines, paged backwards until `from` is covered (max 1000/req). */
async function fetchBinance(symbol, tf, fromMs, toMs){
  const interval = TF_CODE[tf] || tf;
  let out = [], cursor = toMs;
  for(let page = 0; page < 40; page++){
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}`
              + `&endTime=${cursor}&limit=1000`;
    const rows = await get(url);
    if(!rows.length) break;
    const mapped = rows.map(r => ({ t:+r[0], o:+r[1], h:+r[2], l:+r[3], c:+r[4], v:+r[5] }));
    out = mapped.concat(out);
    cursor = mapped[0].t - 1;
    if(mapped[0].t <= fromMs) break;
    await new Promise(r => setTimeout(r, 250));            // be polite
  }
  return out.filter(c => c.t >= fromMs && c.t <= toMs)
            .sort((a,b) => a.t - b.t)
            .filter((c,i,a) => i===0 || c.t !== a[i-1].t);  // de-dupe
}

async function cacheAsset(asset, symbol, tfs, fromMs, toMs){
  fs.mkdirSync(CACHE, { recursive:true });
  const done = [];
  for(const tf of tfs){
    process.stdout.write(`  ${asset} ${tf} … `);
    try{
      const candles = await fetchBinance(symbol, tf, fromMs, toMs);
      const file = path.join(CACHE, `${asset}_${tf}.json`);
      fs.writeFileSync(file, JSON.stringify({
        asset, tf, source:`binance:${symbol}`, fetchedAt:Date.now(),
        from:fromMs, to:toMs, candles
      }));
      console.log(`${candles.length} bars → ${path.basename(file)}`);
      done.push({ asset, tf, bars:candles.length });
    }catch(e){
      console.log(`FAILED — ${e.message}`);
      done.push({ asset, tf, bars:0, error:e.message });
    }
  }
  return done;
}

async function main(){
  /* The earliest benchmark label is 2026-06-19. Fetching from 05-01 leaves ~7
     weeks of genuine warm-up, so the replay's warm-up window cannot swallow
     June labels and report them as misses. */
  const FROM = Date.parse("2026-05-01T00:00:00Z");
  const TO   = Date.parse("2026-07-28T00:00:00Z");
  const scope = (process.argv[2] || "btc").toLowerCase();

  const PLAN = { btc:  [["BTCUSDT","BTCUSDT"]],
                 gold: [["XAUUSD","PAXGUSDT"]],           // PAXG is the tradable gold proxy on Binance
                 all:  [["BTCUSDT","BTCUSDT"],["XAUUSD","PAXGUSDT"]] };
  const targets = PLAN[scope] || PLAN.btc;
  const tfs = ["15m","1H","4H","1D"];

  console.log(`\nDIMITRY · kline cache`);
  console.log(`  window : ${new Date(FROM).toISOString().slice(0,10)} → ${new Date(TO).toISOString().slice(0,10)}`);
  console.log(`  scope  : ${scope}\n`);

  const results = [];
  for(const [asset, symbol] of targets) results.push(...await cacheAsset(asset, symbol, tfs, FROM, TO));

  const ok = results.filter(r => r.bars > 0);
  console.log(`\n  cached ${ok.length}/${results.length} series → ${CACHE}`);
  if(ok.length < results.length){
    console.log(`\n  Some series failed. If every one failed, this machine cannot reach`);
    console.log(`  api.binance.com (VPN / region / firewall). replay.js will tell you what is missing.`);
  }
  return results;
}

if(require.main === module) main().catch(e => { console.error("\nfetch failed:", e.message); process.exit(1); });
module.exports = { fetchBinance, cacheAsset, CACHE };
