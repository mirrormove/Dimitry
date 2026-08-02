/* ============================================================
   STRUCTURE WATCHER          Vault Intelligence v4 · Phase 1
   Emits FACTS ONLY (spec §3): BOS · CHoCH · OB mitigation · FVG fill · sweep(+reclaim)

   params ship VERSIONED — changing pivotBars changes what counts as
   structure, so every change is re-scored against the frozen benchmark
   before deployment (spec §11.2).
   ============================================================ */
"use strict";
const { pivots, atr, beyond, volumeGate, Debouncer, makeEvent, TF_MS, offsetFor } = require("./lib.js");

const PARAMS_VERSION = "structure@2.0.0";
const DEFAULTS = {
  pivotBars:   2,       // confirmed swing = 2 bars either side
  obLookback: 20,       // how far back to look for the origin candle of an impulse
  fvgMinPct: 0.15,      // a gap smaller than this is noise
  sweepMaxAtr: 1.0,     // a wick beyond a swing by more than this is a break, not a sweep
  offsetPct:  null,     // null → per-asset-class (see lib.OFFSET_BY_CLASS)
  minProminenceAtr: 1.0, // a swing must clear its neighbourhood by this much ATR (Step 2c)
  sweepMinTouches:  2    // a sweep only counts at a level price has ALREADY respected
};

/**
 * @param {object} ctx {asset, tf, candles:[{t,o,h,l,c,v}], state?}
 * @param {object} params
 * @returns {Array} events (shadow)
 */
function run(ctx, params){
  const P = Object.assign({}, DEFAULTS, params || {});
  const { asset, tf } = ctx;
  const c = ctx.candles || [];
  const out = [];
  if(c.length < P.pivotBars * 2 + 3) return out;

  const OFF = P.offsetPct == null ? offsetFor(asset) : P.offsetPct;
  const deb = ctx.debouncer || (ctx.debouncer = new Debouncer({ cooldownMs: TF_MS[tf] || TF_MS["1H"] }));
  const A   = atr(c, 14);
  const last = c[c.length-1];
  const prev = c[c.length-2];
  const { highs, lows } = pivots(c.slice(0,-1), P.pivotBars, P.minProminenceAtr);  // exclude the forming bar

  const emit = (o) => {
    /* stamp the BAR TIME. Without this every event carried t=undefined and
       could never match a benchmark label in time — recall would read 0. */
    const e = makeEvent(Object.assign({ t:last.t, asset, tf, watcher:"structure" }, o));
    const d = deb.check(e);
    if(!d.allow){ e.status = "debounced"; e.evidence.debounce = d.reason; out.push(e); return; }
    deb.commit(e);
    out.push(e);
  };

  /* ---------- 1 · BOS / CHoCH ------------------------------
     BOS   = close beyond the most recent confirmed swing IN the direction
             the swing sequence is already going (continuation).
     CHoCH = the FIRST close beyond the opposing swing after a run the
             other way (change of character).                              */
  const lastHigh = highs[highs.length-1], prevHigh = highs[highs.length-2];
  const lastLow  = lows[lows.length-1],   prevLow  = lows[lows.length-2];

  /* NOTE: highs and lows are tested INDEPENDENTLY. Requiring both to exist
     made the watcher silent on clean impulse legs (le_009), where a run of
     higher highs produces no confirmed swing low in the window at all. */
  {
    const upTrend   = prevHigh && prevLow && lastHigh && lastLow && lastHigh.p > prevHigh.p && lastLow.p > prevLow.p;
    const downTrend = prevHigh && prevLow && lastHigh && lastLow && lastHigh.p < prevHigh.p && lastLow.p < prevLow.p;
    const vg = volumeGate(c);

    if(lastHigh && beyond(last.c, lastHigh.p, "up", OFF)){
      const isCHoCH = downTrend;                     // breaking UP while the sequence was down
      emit({
        type: isCHoCH ? "CHOCH_CONFIRMED" : "BOS_CONFIRMED",
        level: lastHigh.p, tier:2,
        fact: `${tf} closed ${last.c} above the ${isCHoCH?"opposing ":""}swing high ${lastHigh.p}`,
        evidence:{ close:last.c, level:lastHigh.p, direction:"up", volMult:vg.mult,
                   trend: upTrend?"up":downTrend?"down":"mixed" },
        confirm:{ basis:"close", tf, offsetPct:OFF, volMult:vg.mult, passed:vg.passed },
        /* the volume arbiter does not veto the fact — it grades it (le_014) */
        confidence: vg.passed === false ? 0.45 : vg.passed === true ? 0.85 : 0.65,
        affects:[`${asset}.structure.${tf}`]
      });
    }
    if(lastLow && beyond(last.c, lastLow.p, "down", OFF)){
      const isCHoCH = upTrend;
      emit({
        type: isCHoCH ? "CHOCH_CONFIRMED" : "BOS_CONFIRMED",
        level: lastLow.p, tier:2,
        fact: `${tf} closed ${last.c} below the ${isCHoCH?"opposing ":""}swing low ${lastLow.p}`,
        evidence:{ close:last.c, level:lastLow.p, direction:"down", volMult:vg.mult,
                   trend: upTrend?"up":downTrend?"down":"mixed" },
        confirm:{ basis:"close", tf, offsetPct:OFF, volMult:vg.mult, passed:vg.passed },
        confidence: vg.passed === false ? 0.45 : vg.passed === true ? 0.85 : 0.65,
        affects:[`${asset}.structure.${tf}`]
      });
    }
  }

  /* ---------- 2 · SWEEP / SWEEP_RECLAIM ---------------------
     A wick beyond a prior swing that CLOSES BACK INSIDE = liquidity taken,
     not a break. This is the vault's most profitable recurring pattern
     (07-01, 07-09) and the one that produced its worst stop (07-05).      */
  /* SWEEP REBUILT in Step 2c. The old version fired on any wick beyond any
     2-bar pivot and scored AT RANDOM (net −0.031) — despite sweep-reversals
     being the operator's best pattern at 6/6 in the record. The detector was
     finding "a wick beyond a local wiggle"; the operator finds "a liquidity
     sweep at a level that matters". A level matters if price has respected it
     before, so a sweep now requires prior touches. */
  ctx.touchMemo = ctx.touchMemo || {};
  const touchesAt = (lvl) => {
    let n = 0;
    for(const b of c.slice(0,-1)) if(Math.abs(b.l - lvl)/lvl < 0.002 || Math.abs(b.h - lvl)/lvl < 0.002) n++;
    return n;
  };
  const checkSweep = (piv, dir) => {
    if(!piv || !A) return;
    if(touchesAt(piv.p) < P.sweepMinTouches) return;   // the level was never respected → not liquidity
    const wickBeyond = dir === "down" ? piv.p - last.l : last.h - piv.p;
    if(wickBeyond <= 0) return;
    if(wickBeyond > A * P.sweepMaxAtr) return;                 // too deep → it is a break
    const closedBack = dir === "down" ? last.c > piv.p : last.c < piv.p;
    if(!closedBack) return;
    const reclaim = dir === "down" ? last.c > prev.c : last.c < prev.c;
    emit({
      type: reclaim ? "SWEEP_RECLAIM" : "SWEEP",
      level: piv.p, tier:2,
      fact: `${tf} wicked ${wickBeyond.toFixed(4)} beyond the swing ${dir==="down"?"low":"high"} `
          + `${piv.p} (${(wickBeyond/piv.p*100).toFixed(3)}%) and closed back inside at ${last.c}`,
      evidence:{ wick: dir==="down"?last.l:last.h, level:piv.p, wickBeyond:+wickBeyond.toFixed(4),
                 atr:+A.toFixed(4), atrFraction:+(wickBeyond/A).toFixed(2), reclaim },
      confirm:{ basis:"wick+close", tf },
      confidence: wickBeyond < A*0.5 ? 0.8 : 0.6,
      affects:[`${asset}.structure.${tf}`]
    });
  };
  checkSweep(lastLow, "down");
  checkSweep(lastHigh, "up");

  /* ---------- 3 · FVG (fair value gap) + fill ---------------
     3-bar imbalance: bar1.h < bar3.l (bullish) — no trade occurred between.  */
  const gaps = [];
  for(let i=Math.max(1,c.length-P.obLookback); i<c.length-2; i++){
    const a=c[i-1], b=c[i], d=c[i+1];
    if(!a||!b||!d) continue;
    if(a.h < d.l && (d.l-a.h)/a.h*100 >= P.fvgMinPct) gaps.push({ lo:a.h, hi:d.l, dir:"bull", t:b.t });
    if(a.l > d.h && (a.l-d.h)/d.h*100 >= P.fvgMinPct) gaps.push({ lo:d.h, hi:a.l, dir:"bear", t:b.t });
  }
  /* A gap is FILLED ONCE. Re-emitting on every bar while price sits inside the
     zone produced 593 duplicate events in the first real replay — the single
     largest source of structure noise. Fill is a state transition, not a
     per-bar condition, so consumed zones are remembered. */
  ctx.consumed = ctx.consumed || new Set();
  for(const g of gaps){
    const filled = last.l <= g.hi && last.h >= g.lo;
    if(!filled) continue;
    const zid = `fvg|${g.dir}|${g.lo}|${g.hi}`;
    if(ctx.consumed.has(zid)) continue;
    ctx.consumed.add(zid);
    emit({
      /* DEMOTED to tier-1 in Step 2c. Measured net edge −0.146 vs random:
         worse than a coin flip. Kept for bookkeeping, never wakes reasoning. */
      type:"FVG_FILLED", level:+((g.lo+g.hi)/2).toFixed(6), tier:1,
      fact:`${tf} traded back into the ${g.dir}ish fair-value gap ${g.lo}–${g.hi}`,
      evidence:{ gapLo:g.lo, gapHi:g.hi, dir:g.dir, formedAt:g.t },
      confirm:{ basis:"touch", tf },
      confidence:0.7,
      affects:[`${asset}.structure.${tf}`]
    });
  }

  /* ---------- 4 · Order block mitigation --------------------
     The last opposing candle before the impulse that broke structure.
     "Mitigated" = price has traded back into it.                          */
  for(let i=c.length-3; i>=Math.max(1,c.length-P.obLookback); i--){
    const o=c[i], nxt=c[i+1];
    if(!o||!nxt) continue;
    const bearOB = o.c > o.o && nxt.c < nxt.o && nxt.c < o.l;   // up candle, then impulse down through it
    const bullOB = o.c < o.o && nxt.c > nxt.o && nxt.c > o.h;   // down candle, then impulse up through it
    if(!bearOB && !bullOB) continue;
    const lo=Math.min(o.o,o.c), hi=Math.max(o.o,o.c);
    if(last.l <= hi && last.h >= lo){
      /* an order block is mitigated ONCE — 1,336 duplicates in the first replay */
      const zid = `ob|${bearOB?"bear":"bull"}|${o.t}|${lo}|${hi}`;
      if(ctx.consumed.has(zid)) break;
      ctx.consumed.add(zid);
      emit({
        type:"OB_MITIGATED", level:+((lo+hi)/2).toFixed(6), tier:2,
        fact:`${tf} traded back into the ${bearOB?"bearish":"bullish"} order block ${lo}–${hi}`,
        evidence:{ obLo:lo, obHi:hi, dir:bearOB?"bear":"bull", formedAt:o.t },
        confirm:{ basis:"touch", tf }, confidence:0.65,
        affects:[`${asset}.structure.${tf}`]
      });
      break;                                    // nearest unmitigated OB only
    }
  }

  return out;
}

module.exports = { run, PARAMS_VERSION, DEFAULTS, id:"structure" };
