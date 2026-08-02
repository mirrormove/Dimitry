/* ============================================================
   SCORING / K2 IDENTITY TESTS      Vault Intelligence v4 · K2
   Structure identity = type + direction + timeframe + timing;
   price is a secondary quality measure, never the identity gate.
   ============================================================ */
"use strict";
const { scoreWatcher, matches, eventDirection } = require("./score.js");
const D = s => Date.parse(s);
const T = [], ok = (n,c,x) => T.push((c?"PASS ":"FAIL ")+n+(c||!x?"":"   → "+x));

const t0 = D("2026-07-04T00:00:00Z");
const label = { watcher:"structure", detectability:"hard", type:"BOS_CONFIRMED", asset:"BTCUSDT",
                tf:"4H", level:65000, t:t0, fact:"bullish BOS reclaimed 65,000 higher-low", forward:false };

/* ══════════ IDENTITY: price is not the gate ══════════ */
{
  const near = { type:"BOS_CONFIRMED", asset:"BTCUSDT", tf:"4H", level:65180, t:t0+36e5, evidence:{direction:"up"} };
  ok("same type+dir+tf+timing, +0.28% level → MATCH under K2", matches(near, label) === true);
  ok("same event FAILS the legacy strict-price gate (proves K2 is the change)",
     matches(near, label, {strictLevel:true}) === false);

  const farLevel = { type:"BOS_CONFIRMED", asset:"BTCUSDT", tf:"4H", level:69000, t:t0+36e5, evidence:{direction:"up"} };
  ok("a level off by >3% is NOT the same episode (loose sanity bound holds)", matches(farLevel, label) === false);
}

/* ══════════ DIRECTION: the safeguard ══════════ */
{
  const opp = { type:"BOS_CONFIRMED", asset:"BTCUSDT", tf:"4H", level:65100, t:t0+36e5, evidence:{direction:"down"} };
  ok("opposite direction (both known) → NO match", matches(opp, label) === false);

  const noDir = { type:"BOS_CONFIRMED", asset:"BTCUSDT", tf:"4H", level:65100, t:t0+36e5 };  // no evidence
  ok("missing direction never forces a mismatch (matches on type+tf+timing)", matches(noDir, label) === true);

  ok("direction is read from evidence", eventDirection({type:"BOS_CONFIRMED",evidence:{direction:"up"}}) === "up");
  ok("direction is read from the fact text", eventDirection({type:"CHOCH_CONFIRMED",fact:"bearish CHoCH, lower-high"}) === "down");
  ok("a reclaim is up by type semantics", eventDirection({type:"SWEEP_RECLAIM"}) === "up");
  ok("an unsigned BOS with no evidence is unknown (null)", eventDirection({type:"BOS_CONFIRMED"}) === null);
}

/* ══════════ TIMEFRAME & TIMING still gate ══════════ */
{
  const wrongTf = { type:"BOS_CONFIRMED", asset:"BTCUSDT", tf:"1H", level:65010, t:t0, evidence:{direction:"up"} };
  ok("a 1H event does not match a 4H label", matches(wrongTf, label) === false);
  const late = { type:"BOS_CONFIRMED", asset:"BTCUSDT", tf:"4H", level:65010, t:t0+5*864e5, evidence:{direction:"up"} };
  ok("outside the timing window → no match", matches(late, label) === false);
}

/* ══════════ LEVEL QUALITY is reported, not gated ══════════ */
{
  const labels = [ label,
    { watcher:"structure", detectability:"hard", type:"SWEEP_RECLAIM", asset:"BTCUSDT", tf:"4H",
      level:58030, t:D("2026-07-01T00:00:00Z"), fact:"sell-side swept then reclaimed", forward:false } ];
  // stub the benchmark by scoring emitted against a private label set is not exposed;
  // instead assert the metric shape via a matched pair through scoreWatcher on the real book.
  const emitted = [
    { type:"BOS_CONFIRMED", asset:"BTCUSDT", tf:"4H", level:65200, t:t0+36e5, evidence:{direction:"up"}, confidence:0.8 }
  ];
  const r = scoreWatcher("structure", emitted, { scopeAssets:["BTCUSDT"] });
  ok("scoreWatcher runs and reports an identity rule", /K2/.test(r.metrics.identityRule));
  ok("levelQuality is a reported block (or null), never a gate reason",
     !r.reasons.some(x=>/level|deviation|price/i.test(x)));
}

console.log(T.join("\n"));
const f = T.filter(x=>x.startsWith("FAIL"));
console.log(f.length ? `\n*** ${f.length} FAIL / ${T.length} ***` : `\nALL ${T.length} PASS`);
process.exit(f.length?1:0);
