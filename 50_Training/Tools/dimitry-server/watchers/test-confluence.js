/* ============================================================
   CONFLUENCE ENGINE TESTS   Vault Intelligence v4 · Step 5
   The point: independent lenses, not internal echo. Measured correlation
   discounts; thin single-lens reads never claim confluence.
   ============================================================ */
"use strict";
const C = require("./confluence.js");
const { BeliefStore } = require("../belief-store.js");
const T=[], ok=(n,c,x)=>T.push((c?"PASS ":"FAIL ")+n+(c||!x?"":"   → "+x));
const D=s=>Date.parse(s), NOW=D("2026-07-28T12:00:00Z"), hAgo=h=>NOW-h*3.6e6;

/* ══════════ INTERNAL ECHO IS NOT CONFLUENCE ══════════ */
{
  // bias + setup both point short — but they are the SAME lens (setup derived from bias)
  const s = [
    { key:"BTCUSDT.bias", lens:"structure", dir:-1, weight:0.6 },
    { key:"BTCUSDT.primarySetup", lens:"structure", dir:-1, weight:0.6 }
  ];
  const r = C.confluence(s, {});
  ok("two same-lens signals collapse to ONE independent vote", r.independentLenses===1);
  ok("a single lens is THIN, never CONFLUENCE", r.verdict==="THIN");
}

/* ══════════ DIFFERENT LENSES ALIGNING = REAL CONFLUENCE ══════════ */
{
  const s = [
    { key:"BTCUSDT.bias", lens:"structure", dir:-1, weight:0.6 },
    { key:"macro.dollar", lens:"macro", dir:-1, weight:0.7 },
    { key:"BTCUSDT.flow.volume", lens:"flow", dir:-1, weight:0.55 }
  ];
  const r = C.confluence(s, {});
  ok("three independent lenses aligned → CONFLUENCE", r.verdict==="CONFLUENCE" && r.independentLenses===3);
  ok("confluence direction is the agreed one (short)", r.netDir===-1);
  ok("no opposing lenses", r.opposing.length===0);
}

/* ══════════ DIVERGENCE ══════════ */
{
  const s = [
    { key:"BTCUSDT.bias", lens:"structure", dir:1, weight:0.6 },
    { key:"macro.dollar", lens:"macro", dir:-1, weight:0.7 }
  ];
  const r = C.confluence(s, {});
  ok("lenses pointing opposite ways → DIVERGENCE", r.verdict==="DIVERGENCE");
  ok("divergence records both sides", r.aligned.length===1 && r.opposing.length===1);
}

/* ══════════ MEASURED CORRELATION DISCOUNTS (gate) ══════════ */
{
  const s = [
    { key:"BTCUSDT.bias", lens:"structure", dir:-1, weight:0.6 },
    { key:"macro.dollar", lens:"macro", dir:-1, weight:0.7 },
    { key:"correlation.usdtd.btc", lens:"correlation", dir:-1, weight:0.5 }
  ];
  // macro & correlation are MEASURED-correlated → they must not count as two independent votes
  const matrix = { [["macro.dollar","correlation.usdtd.btc"].sort().join("|")]: { n:12, lift:1.8, gate:"correlated" } };
  const plain = C.confluence(s, {});
  const gated = C.confluence(s, matrix);
  ok("without the matrix, 3 lenses look independent", plain.independentLenses===3);
  ok("a measured-correlated pair is merged to one vote", gated.independentLenses===2 && gated.mergedOut.length===1);
  ok("still CONFLUENCE, but honestly counted", gated.verdict==="CONFLUENCE");
}

/* ══════════ MATRIX GATES ══════════ */
{
  const ev=(t,keys)=>({ t, affects:keys });
  const events=[];
  // A & B co-occur 10× within window; A alone and B alone padded so lift is high
  for(let i=0;i<10;i++) events.push(ev(NOW+i*36e5, ["K.a","K.b"]));
  for(let i=0;i<3;i++)  events.push(ev(NOW+1e9+i*36e5, ["K.c"]));         // far apart, low co-occur
  const m = C.buildMatrix(events, { windowMs:2*36e5 });
  const ab = m[["K.a","K.b"].sort().join("|")];
  ok("a frequently co-occurring pair clears the sample gate", ab && ab.n>=C.MIN_PAIR);
  ok("and is flagged correlated by lift", ab && ab.gate==="correlated");
  // a pair seen only twice is insufficient
  const few=[ev(NOW,["X.a","X.b"]), ev(NOW+36e5,["X.a","X.b"])];
  const m2=C.buildMatrix(few,{windowMs:2*36e5});
  ok("a rarely-seen pair is gated INSUFFICIENT, not trusted",
     m2[["X.a","X.b"].sort().join("|")].gate==="insufficient");
}

/* ══════════ run() over a store ══════════ */
{
  const store=new BeliefStore("/tmp/cfl-"+Math.random().toString(36).slice(2)+".json");
  store.set({ key:"BTCUSDT.bias", claim:"BTC bias", value:"bear 58/42", confidence:0.58, class:"structure",
              asset:"BTCUSDT", setAt:hAgo(5) });
  store.set({ key:"macro.dollar", claim:"Dollar", value:"dollar-positive on level and direction",
              confidence:0.67, class:"macro", setAt:hAgo(5), invalidator:"EURUSD daily close > 1.1418" });
  const r=C.run(store,{now:NOW});
  ok("run emits a CONFLUENCE for aligned independent lenses (structure bear + dollar-positive)",
     r.events.some(e=>e.type==="CONFLUENCE" && e.asset==="BTCUSDT"));
  ok("summary is human-readable", /assets/.test(C.summarise(r)));
}

console.log(T.join("\n"));
const f=T.filter(x=>x.startsWith("FAIL"));
console.log(f.length ? `\n*** ${f.length} FAIL / ${T.length} ***` : `\nALL ${T.length} PASS`);
process.exit(f.length?1:0);
