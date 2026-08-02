/* ============================================================
   MACRO / REGIME / CALENDAR / CORRELATION WATCHER TESTS
   Vault Intelligence v4 · Step 4b
   ============================================================ */
"use strict";
const M = require("./macro.js");
const { BeliefStore } = require("../belief-store.js");

const T = [], ok = (n,c,x) => T.push((c?"PASS ":"FAIL ")+n+(c||!x?"":"   → "+x));
const U = (...a) => Date.UTC(...a);

/* ══════════ eventDate PARSING ══════════ */
{
  const now = U(2026,6,28,12,0);                       // 2026-07-28 12:00Z
  ok("parses a 'Mon DD' calendar date", M.eventDate("FOMC Jul 30 — hike live on the dots", now) === U(2026,6,30,13,0));
  ok("parses an ISO date", M.eventDate("CPI 2026-08-12 release", now) === U(2026,7,12,13,0));
  ok("honours an explicit clock", M.eventDate("NFP Aug 1 13:30", now) === U(2026,7,1,13,30));
  ok("rolls a long-past date to next year", M.eventDate("event Jan 3", now) === U(2027,0,3,13,0));
  ok("returns null when there is no date", M.eventDate("real yields remain the driver", now) === null);
}

/* ══════════ dollar → crypto sign ══════════ */
{
  ok("dollar-positive = headwind for crypto longs (−1)", M.dollarCryptoSign("dollar-positive on level and direction") === -1);
  ok("weak dollar = tailwind (+1)", M.dollarCryptoSign("weak dollar, DXY rolling over") === 1);
  ok("no clear side = 0", M.dollarCryptoSign("dollar chopping sideways, no lean") === 0);
}

/* fixtures */
function book(now, dollarVal, eventVal){
  const s = new BeliefStore("/tmp/macro-"+Math.random().toString(36).slice(2)+".json");
  s.set({ key:"macro.dollar", claim:"Dollar backdrop", value:dollarVal, confidence:0.67, prior:0.5,
          class:"macro", setAt:now-40*36e5, setBy:"agent",
          invalidator:"EURUSD daily close > 1.1418" });
  s.set({ key:"macro.fomc", claim:"FOMC", value:eventVal, confidence:0.84, prior:0.5,
          class:"macro", setAt:now-40*36e5, setBy:"agent" });
  s.set({ key:"correlation.usdtd.btc", claim:"USDT.D → BTC", value:"inverse, proven lead",
          confidence:0.62, prior:0.5, class:"correlation", setAt:now-200*36e5, setBy:"agent" });
  return s;
}

/* ══════════ REGIME_NOTE + CORRELATION_UNGUARDED ══════════ */
{
  const now = U(2026,6,28,12,0);
  const s = book(now, "dollar-positive on both level and direction", "FOMC Jul 30 — hike live on the dots");
  const r = M.run(s, { now });
  const rn = r.events.find(e=>e.type==="REGIME_NOTE");
  ok("emits a REGIME_NOTE", !!rn);
  ok("REGIME_NOTE is tier-1 surfacing", !!rn && rn.tier===1);
  ok("REGIME_NOTE reads the risk sign (dollar+ → risk-off)", !!rn && /risk-off/i.test(rn.fact));
  const cu = r.events.find(e=>e.type==="CORRELATION_UNGUARDED");
  ok("flags the un-invalidated correlation belief", !!cu && cu.tier===2 && cu.affects[0]==="correlation.usdtd.btc");
}

/* ══════════ CALENDAR: NEWS_AHEAD vs NEWS_WINDOW ══════════ */
{
  const now = U(2026,6,28,12,0);                        // ~49h before Jul 30 13:00
  const r = M.run(book(now, "dollar-positive", "FOMC Jul 30"), { now });
  ok("event ~49h out → NEWS_AHEAD (heads-up)", r.events.some(e=>e.type==="NEWS_AHEAD" && e.tier===2));
  ok("not yet a live NEWS_WINDOW", !r.events.some(e=>e.type==="NEWS_WINDOW"));
  ok("newsWindowNow is false 2 days out", M.newsWindowNow(book(now,"x","FOMC Jul 30"), now) === false);

  const near = U(2026,6,30,6,0);                        // Jul 30 06:00 → event 13:00 = 7h out
  const r2 = M.run(book(near, "dollar-positive", "FOMC Jul 30"), { now: near });
  ok("event 7h out → NEWS_WINDOW live", r2.events.some(e=>e.type==="NEWS_WINDOW" && e.tier===3));
  ok("newsWindowNow is true inside the window", M.newsWindowNow(book(near,"x","FOMC Jul 30"), near) === true);
}

/* ══════════ REGIME_CONFLICT ══════════ */
{
  const now = U(2026,6,28,12,0);
  const s = book(now, "dollar-positive on both level and direction", "FOMC Jul 30");
  s.set({ key:"BTCUSDT.primarySetup", claim:"BTC dip long", value:"LONG the SMA200 63,330–63,670 · T1 65,354",
          confidence:0.6, prior:0.5, class:"opportunity", asset:"BTCUSDT", setAt:now-3*36e5, setBy:"agent",
          invalidator:"1D close < 62,900" });
  const r = M.run(s, { now });
  const rc = r.events.find(e=>e.type==="REGIME_CONFLICT");
  ok("a crypto LONG in a dollar-positive regime is flagged", !!rc && rc.tier===3);
  ok("REGIME_CONFLICT posed as a question, not a verdict", !!rc && /deliberate fade|needs reconciling/i.test(rc.fact+JSON.stringify(rc.evidence)));

  // a crypto SHORT in the SAME regime aligns → no conflict
  const s2 = book(now, "dollar-positive", "FOMC Jul 30");
  s2.set({ key:"BTCUSDT.primarySetup", claim:"BTC OB short", value:"SHORT the OB 65,354–66,000 · T3 63,329",
           confidence:0.6, class:"opportunity", asset:"BTCUSDT", setAt:now-3*36e5, setBy:"agent" });
  ok("a crypto SHORT aligned with risk-off raises NO conflict",
     !M.run(s2,{now}).events.some(e=>e.type==="REGIME_CONFLICT"));

  // FX is not crypto → no dollar-inverse conflict claimed
  const s3 = book(now, "dollar-positive", "FOMC Jul 30");
  s3.set({ key:"EURUSD.primarySetup", claim:"EUR long", value:"LONG EURUSD 1.14",
           confidence:0.6, class:"opportunity", asset:"EURUSD", setAt:now-3*36e5, setBy:"agent" });
  ok("FX setups are NOT force-fit to the crypto-inverse rule",
     !M.run(s3,{now}).events.some(e=>e.type==="REGIME_CONFLICT"));

  // neutral dollar → no regime conflict at all
  const s4 = book(now, "dollar chopping, no lean", "FOMC Jul 30");
  s4.set({ key:"BTCUSDT.primarySetup", claim:"BTC long", value:"LONG 63,330",
           confidence:0.6, class:"opportunity", asset:"BTCUSDT", setAt:now-3*36e5, setBy:"agent" });
  ok("a neutral dollar raises no regime conflict", !M.run(s4,{now}).events.some(e=>e.type==="REGIME_CONFLICT"));
}

/* ══════════ summary ══════════ */
{
  const now = U(2026,6,28,12,0);
  ok("summary is human-readable", /regime/.test(M.summarise(M.run(book(now,"dollar-positive","FOMC Jul 30"),{now}))));
}

console.log(T.join("\n"));
const f = T.filter(x=>x.startsWith("FAIL"));
console.log(f.length ? `\n*** ${f.length} FAIL / ${T.length} ***` : `\nALL ${T.length} PASS`);
process.exit(f.length?1:0);
