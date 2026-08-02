/* ============================================================
   WATCHER FIXTURE TESTS      Vault Intelligence v4 · Phase 1

   Candle fixtures are RECONSTRUCTED from what the analysis notes
   actually recorded (levels, wicks, closes), so detection logic is
   provable without a live kline feed. Full historical scoring runs
   on the laptop via replay.js, where Binance is reachable.

   Each test names the labelled event it encodes.
   ============================================================ */
"use strict";
const S = require("./structure.js");
const L = require("./level.js");
const { Debouncer } = require("./lib.js");

const T = [], ok = (n,c,extra) => T.push((c?"PASS ":"FAIL ")+n+(c||!extra?"":"   → "+extra));
const H = 36e5;
/** build ascending candles from [o,h,l,c,v] rows */
const mk = (rows, t0, step) => rows.map((r,i)=>({ t:(t0||0)+i*(step||H), o:r[0],h:r[1],l:r[2],c:r[3],v:r[4]==null?100:r[4] }));

/* ══════════ STRUCTURE ══════════ */

/* le_005 · 2026-07-05 · wick to 61,297 swept the 61,300 pivot by 3 points, then V-recovered.
   The canonical stop-hunt. Must be a SWEEP, never a break.                */
{
  const rows = [
    [61800,61850,61700,61750],[61750,61800,61650,61700],[61700,61750,61500,61550],
    [61550,61600,61450,61500],[61500,61550,61400,61450],   // pivot low forms here (61,400)
    [61450,61520,61410,61480],[61480,61550,61430,61500],
    [61500,61550,61297,61520,180]                          // wick 61,297 → close back at 61,520
  ];
  const ev = S.run({ asset:"BTCUSDT", tf:"15m", candles: mk(rows, Date.parse("2026-07-05T00:00:00Z"), 9e5) });
  const sweep = ev.find(e => /SWEEP/.test(e.type));
  ok("le_005 · 15m stop-hunt detected as SWEEP not BREAK", !!sweep, "types: "+ev.map(e=>e.type).join(","));
  ok("le_005 · sweep is a reclaim (closed back up)", !!sweep && sweep.type === "SWEEP_RECLAIM");
  ok("le_005 · no BOS emitted (it did not close beyond)", !ev.some(e=>e.type==="BOS_CONFIRMED"&&e.evidence.direction==="down"));
}

/* le_009 · 2026-07-09 · 15m closed above 63,030 — structure flip that ran +4%. */
{
  const rows = [
    [62000,62200,61900,62100],[62100,62300,62000,62200],[62200,62500,62100,62400],  // swing high 62,500
    [62400,62450,62150,62200],[62200,62350,62100,62300],
    [62300,62600,62250,62550],[62550,62700,62450,62650],
    [62650,63200,62600,63150,300]                        // closes beyond the prior swing high
  ];
  const ev = S.run({ asset:"BTCUSDT", tf:"15m", candles: mk(rows, Date.parse("2026-07-09T00:00:00Z"), 9e5) });
  const bos = ev.find(e => /BOS_CONFIRMED|CHOCH/.test(e.type) && e.evidence.direction === "up");
  ok("le_009 · upside structure break detected", !!bos, "types: "+ev.map(e=>e.type).join(","));
  ok("le_009 · volume gate graded the break", !!bos && bos.confirm.volMult != null);
}

/* le_014 · 2026-07-21 · THE NON-EVENT. Price reached 66,956 but never CLOSED
   above 67,292, and volume never met the gate. A naive detector fires here. */
{
  const rows = [
    [65000,65500,64800,65300],[65300,65800,65200,65700],[65700,66200,65600,66100],
    [66100,66500,66000,66400],[66400,66800,66300,66700],
    [66700,66956,66500,66600, 60]                        // high 66,956 · closes BELOW · thin volume
  ];
  const ev = S.run({ asset:"BTCUSDT", tf:"4H", candles: mk(rows, Date.parse("2026-07-21T00:00:00Z"), 144e5) });
  const falseBreak = ev.find(e => e.type==="BOS_CONFIRMED" && e.evidence.direction==="up" && e.level >= 67000);
  ok("le_014 · does NOT emit a break it never closed beyond", !falseBreak,
     "emitted: "+ev.map(e=>e.type+"@"+e.level).join(","));
}

/* FVG: a clean 3-bar imbalance that later fills. */
{
  const rows = [
    [59800,59900,59700,59850],[59850,59950,59750,59900],
    [60000,60100,59900,60050],[60050,60200,60000,60150],
    [60150,60300,60100,60250],                            // bar A high 60,300
    [60600,60900,60550,60800],                            // gap: A.h 60,300 < C.l 60,550
    [60800,60950,60600,60700],
    [60700,60800,60250,60350]                             // trades back into the gap
  ];
  const ev = S.run({ asset:"BTCUSDT", tf:"1H", candles: mk(rows, Date.parse("2026-07-16T00:00:00Z")) });
  ok("FVG fill detected (le_010 pattern)", ev.some(e=>e.type==="FVG_FILLED"), "types: "+ev.map(e=>e.type).join(","));
}

/* ══════════ LEVEL ══════════ */

/* le_013 · 2026-07-20 · low 63,100 vs zone top 63,094 — missed by 6 points (~0.01%).
   The costliest leak in the record. Silence here would be a design failure. */
{
  const rows = [
    [64000,64100,63800,63900],[63900,64000,63600,63700],
    [63700,63800,63100,63400, 150]                        // low 63,100 · never reached 63,094
  ];
  const ev = L.run({ asset:"BTCUSDT", tf:"1D", candles: mk(rows, Date.parse("2026-07-20T00:00:00Z"), 864e5),
                     levels:[{ p:63094, key:true, lbl:"pivot + weekly SMA200 — the floor bounce (a PLANNED ENTRY)" }] });
  const miss = ev.find(e => e.type === "LEVEL_TEST_MISSED");
  ok("le_013 · near-miss emitted (missed by 6 pts)", !!miss, "types: "+ev.map(e=>e.type).join(","));
  ok("le_013 · distance recorded < 0.02%", !!miss && miss.evidence.distancePct < 0.02,
     miss ? miss.evidence.distancePct+"%" : "n/a");
  ok("le_013 · no false LEVEL_BREAK", !ev.some(e=>e.type==="LEVEL_BREAK"));

  /* the same bar against a NON-key level must NOT raise a missed-entry signal */
  const evPlain = L.run({ asset:"BTCUSDT", tf:"1D", candles: mk(rows, Date.parse("2026-07-20T00:00:00Z"), 864e5),
                     levels:[{ p:63094, lbl:"ordinary ladder level" }] });
  ok("near-miss stays silent on a non-key level",
     !evPlain.some(e => e.type === "LEVEL_TEST_MISSED"), "types: "+evPlain.map(e=>e.type).join(","));
}

/* le_031 · 2026-07-23 · GBPUSD daily closed 1.3352, below the 1.3360 shelf. */
{
  const rows = [
    [1.3420,1.3440,1.3400,1.3410,0],[1.3410,1.3425,1.3380,1.3395,0],
    [1.3395,1.3400,1.3345,1.3352,0]                      // closes below 1.3360 by 0.06% · no volume feed
  ];
  const ev = L.run({ asset:"GBPUSD", tf:"1D", candles: mk(rows, Date.parse("2026-07-23T00:00:00Z"), 864e5),
                     levels:[{ p:1.3360, lbl:"the shelf — bull case floor" }] });
  const br = ev.find(e=>e.type==="LEVEL_BREAK");
  ok("le_031 · GBPUSD shelf break on close", !!br, "types: "+ev.map(e=>e.type).join(","));
  ok("le_031 · direction down", !!br && br.evidence.direction==="down");
  ok("le_031 · FX has no volume feed → gate honestly null", !!br && br.confirm.passed === null);
}

/* le_022 · 2026-07-21 · XAU tagged 4,084.20 above R3 4,081.52 and rejected. */
{
  const rows = [
    [4050,4060,4045,4055],[4055,4070,4050,4065],
    [4065,4084.20,4060,4072]                             // wick above, close back under
  ];
  const ev = L.run({ asset:"XAUUSD", tf:"1H", candles: mk(rows, Date.parse("2026-07-21T13:00:00Z")),
                     levels:[{ p:4081.52, lbl:"R3 — fib 0.618 / lower high" }] });
  ok("le_022 · XAU level rejection detected", ev.some(e=>e.type==="LEVEL_REJECT"), "types: "+ev.map(e=>e.type).join(","));
}

/* 0.1% offset rule: a close only 0.02% beyond a level is NOT a break. */
{
  const rows = [[65000,65100,64900,65000],[65000,65100,64950,65010],[65010,65080,64990,65013]];
  const ev = L.run({ asset:"BTCUSDT", tf:"1H", candles: mk(rows, Date.parse("2026-07-10T00:00:00Z")),
                     levels:[{ p:65000, lbl:"round number" }] });
  ok("0.1% offset · a 0.02% close-through is NOT a break",
     !ev.some(e=>e.type==="LEVEL_BREAK"), "types: "+ev.map(e=>e.type).join(","));
}

/* ══════════ DEBOUNCE ══════════ */
{
  const d = new Debouncer({ cooldownMs: 36e5, stormMax: 3 });
  const e = (t) => ({ asset:"BTCUSDT", type:"LEVEL_BREAK", level:65000, t });
  const t0 = Date.now();
  const a = d.check(e(t0)); d.commit(e(t0));
  ok("debounce · first fire allowed", a.allow);
  ok("debounce · immediate repeat blocked", !d.check(e(t0+6e4)).allow);
  d.rearm("BTCUSDT","LEVEL_BREAK",65000);
  ok("debounce · still blocked inside cooldown even after re-arm", !d.check(e(t0+6e4)).allow);
  ok("debounce · allowed after cooldown + re-arm", d.check(e(t0+37e5)).allow);

  const d2 = new Debouncer({ cooldownMs: 1, stormMax: 3 });
  let blocked = 0;
  for(let i=0;i<6;i++){
    const ev2 = { asset:"BTCUSDT", type:"BOS_CONFIRMED", level:60000+i, t:t0+i*1000 };
    const r = d2.check(ev2);
    if(r.allow) d2.commit(ev2); else if(/storm/.test(r.reason)) blocked++;
    d2.rearm("BTCUSDT","BOS_CONFIRMED",60000+i);
  }
  ok("debounce · storm guard caps events/hour", blocked >= 2, "blocked="+blocked);
}

/* ══════════ SHADOW MODE ══════════ */
{
  /* reuse the le_009 fixture — a monotonic staircase has no confirmed swing and
     correctly emits nothing, which would make this assertion vacuous */
  const ev = S.run({ asset:"BTCUSDT", tf:"15m", candles: mk([
    [62000,62200,61900,62100],[62100,62300,62000,62200],[62200,62500,62100,62400],
    [62400,62450,62150,62200],[62200,62350,62100,62300],
    [62300,62600,62250,62550],[62550,62700,62450,62650],
    [62650,63200,62600,63150,300]
  ], Date.parse("2026-07-14T00:00:00Z"), 9e5) });
  ok("all Phase-1 events are SHADOW (nothing consumes them)",
     ev.length > 0 && ev.every(e => e.status === "shadow" || e.status === "debounced"),
     ev.map(e=>e.status).join(","));
  ok("events carry a FACT, never an interpretation",
     ev.every(e => typeof e.fact === "string" && !/bullish bias|hypothesis|probability rises/i.test(e.fact)));
}

console.log(T.join("\n"));
const f = T.filter(x=>x.startsWith("FAIL"));
console.log(f.length ? `\n*** ${f.length} FAIL / ${T.length} ***` : `\nALL ${T.length} PASS`);
process.exit(f.length?1:0);
