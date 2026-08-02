/* ============================================================
   RULE ENGINE TESTS          Vault Intelligence v4 · Step 3
   Uses the REAL invalidators from the seeded belief store.
   ============================================================ */
"use strict";
const path = require("path");
const { parse, evaluate, clauseFired } = require("./invalidator.js");
const { run, summarise } = require("./engine.js");
const { BeliefStore } = require("../belief-store.js");

const T = [], ok = (n,c,x) => T.push((c?"PASS ":"FAIL ")+n+(c||!x?"":"   → "+x));
const D = s => Date.parse(s);
const day = 864e5, h4 = 144e5;
const bars = (rows, t0, step) => rows.map((r,i)=>({ t:t0+i*step, o:r[0],h:r[1],l:r[2],c:r[3],v:r[4]==null?100:r[4] }));

/* ══════════ PARSER ══════════ */
{
  const p = parse("1D close < 4,081", "XAUUSD");
  ok("parses the dominant form", p.parsed && p.clauses[0].tf==="1D" && p.clauses[0].dir==="below" && p.clauses[0].level===4081);

  const v = parse("4H close > 66,400 on volume > 1.5x avg", "BTCUSDT");
  ok("captures the volume qualifier", v.parsed && v.clauses[0].volMult===1.5);

  const a = parse("EURUSD daily close > 1.1418 AND GBPUSD 4H close > 1.33934");
  ok("splits AND clauses with per-clause assets",
     a.parsed && a.join==="AND" && a.clauses.length===2 &&
     a.clauses[0].asset==="EURUSD" && a.clauses[1].asset==="GBPUSD");

  const hold = parse("a hold/reclaim above 163.823 = the CHoCH was a false sweep", "USDJPY");
  ok("hold/reclaim needs TWO closes, not a tag", hold.parsed && hold.clauses[0].hold===2);

  const prose = parse("weekly close < 63,329 would be the most bearish signal on the board", "BTCUSDT");
  ok("survives trailing prose", prose.parsed && prose.clauses[0].tf==="1W" && prose.clauses[0].level===63329);

  const bad = parse("if sentiment deteriorates materially", "BTCUSDT");
  ok("UNPARSEABLE is reported, never silently accepted", !bad.parsed && bad.unparsed.length>0);
}

/* ══════════ CLAUSE FIRING ══════════ */
{
  const c = parse("1D close < 4,081", "XAUUSD").clauses[0];
  const notYet = bars([[4100,4110,4085,4090],[4090,4095,4082,4088]], D("2026-07-27T00:00:00Z"), day);
  ok("does not fire while price holds above", !clauseFired(c, notYet, 0).fired);

  const broke = bars([[4100,4110,4085,4090],[4090,4095,4050,4062]], D("2026-07-27T00:00:00Z"), day);
  const f = clauseFired(c, broke, 0);
  ok("fires on a close below the level", f.fired && f.close===4062);

  /* the belief's own clock: bars BEFORE it was set must not invalidate it.
     Series runs 07-27 → 07-28, so a belief set on 07-29 must see nothing. */
  const since = D("2026-07-29T00:00:00Z");
  ok("ignores bars predating the belief", !clauseFired(c, broke, since).fired);
}

/* ══════════ HOLD SEMANTICS ══════════ */
{
  const c = parse("hold/reclaim > 163.823", "USDJPY").clauses[0];
  const tag = bars([[163.7,163.9,163.6,163.85],[163.85,163.9,163.5,163.60]], D("2026-07-27T00:00:00Z"), h4);
  ok("a single close beyond is NOT a hold", !clauseFired(c, tag, 0).fired);
  const held = bars([[163.7,163.9,163.6,163.85],[163.85,164.0,163.8,163.95]], D("2026-07-27T00:00:00Z"), h4);
  ok("two consecutive closes IS a hold", clauseFired(c, held, 0).fired);
}

/* ══════════ VOLUME GATE ══════════ */
{
  const c = parse("4H close > 66,400 on volume > 1.5x avg", "BTCUSDT").clauses[0];
  const rows = [];
  for(let i=0;i<8;i++) rows.push([66000,66200,65900,66100,100]);
  rows.push([66400,66900,66300,66800, 110]);            // price met, volume thin
  const thin = clauseFired(c, bars(rows, D("2026-07-20T00:00:00Z"), h4), 0);
  ok("price met but volume short → NOT invalidated (the le_014 rule)",
     !thin.fired && thin.partial === true, thin.reason);

  const rows2 = rows.slice(0,-1).concat([[66400,66900,66300,66800, 400]]);
  ok("price met AND volume met → fires", clauseFired(c, bars(rows2, D("2026-07-20T00:00:00Z"), h4), 0).fired);
}

/* ══════════ ENGINE END-TO-END ══════════ */
{
  const store = new BeliefStore("/tmp/rules-test.json");
  const t0 = D("2026-07-26T22:00:00Z");
  store.set({ key:"XAUUSD.bias", claim:"Gold bias", value:"slight bull 52/48",
              confidence:0.52, prior:0.5, class:"structure", asset:"XAUUSD",
              setAt:t0, setBy:"agent", invalidator:"1D close < 4,081" });
  store.set({ key:"XAUUSD.mustHold", claim:"Gold line in the sand", value:4081,
              confidence:0.85, prior:0.5, class:"structure", asset:"XAUUSD",
              setAt:t0, setBy:"agent", invalidator:"1D close < 4,081" });
  store.set({ key:"doctrine.stopCeil.metals", claim:"metals stop ceiling", value:0.8,
              confidence:1, class:"doctrine", setAt:t0, setBy:"operator",
              invalidator:"1D close < 4,081" });          // must be ignored
  store.set({ key:"XAUUSD.vague", claim:"vague one", value:"x", confidence:0.7,
              class:"structure", asset:"XAUUSD", setAt:t0, setBy:"agent",
              invalidator:"if the macro backdrop deteriorates" });

  const candles = { XAUUSD: { "1D": bars(
    [[4090,4100,4080,4092],[4092,4095,4040,4055]], D("2026-07-27T00:00:00Z"), day) } };

  const res = run(store, candles, { now: D("2026-07-29T00:00:00Z") });
  ok("fires on both live gold beliefs", res.updates.length===2, "updates="+res.updates.length);
  ok("raises T4 events", res.events.filter(e=>e.tier===4 && e.type==="INVALIDATOR_FIRED").length===2);
  ok("doctrine is exempt", !res.updates.some(u=>u.key.startsWith("doctrine")));
  ok("unparseable invalidator surfaced", res.unparsed.length===1 && res.unparsed[0].key==="XAUUSD.vague");

  const after = store.get("XAUUSD.bias", D("2026-07-29T00:00:00Z"));
  ok("confidence collapsed to the prior", Math.abs(after.confidence-0.5)<1e-9, "conf="+after.confidence);
  ok("value PRESERVED — the rule does not re-read the market", after.value==="slight bull 52/48");
  ok("marked invalidated + awaiting reasoning", after.status==="invalidated" && after.awaitingReasoning===true);
  ok("invalidator cleared so it cannot re-fire", after.invalidator===null);
  ok("history chain intact (old record survives)", store.history("XAUUSD.bias").length===2);
  ok("setBy records it was a rule, not the agent", after.setBy==="rule");

  const res2 = run(store, candles, { now: D("2026-07-29T00:00:00Z") });
  ok("idempotent — a dead belief does not re-fire", res2.updates.length===0, "updates="+res2.updates.length);

  ok("summary is human-readable", /beliefs carry an invalidator/.test(summarise(res)));
}

console.log(T.join("\n"));
const f = T.filter(x=>x.startsWith("FAIL"));
console.log(f.length ? `\n*** ${f.length} FAIL / ${T.length} ***` : `\nALL ${T.length} PASS`);
process.exit(f.length?1:0);
