/* ============================================================
   LEVEL WATCHER              Vault Intelligence v4 · Phase 1
   Watches the analysis ladder (VAULT.…analysis.levels[]).
   Emits FACTS ONLY: LEVEL_BREAK · LEVEL_REJECT · TOUCH_COUNT · LEVEL_TEST_MISSED

   LEVEL_TEST_MISSED exists because the operator's single most expensive
   measured leak is entry-placement: le_013 (Jul-20 low 63,100 vs zone top
   63,094 — missed by 6 points, forfeiting ~+4.2R) and le_037 (USDJPY high
   163.82 vs a 163.90 zone — missed by 8 pips). A watcher that only reports
   hits would stay silent on exactly the events that cost the most.
   ============================================================ */
"use strict";
const { atr, beyond, volumeGate, Debouncer, makeEvent, TF_MS, offsetFor } = require("./lib.js");

const PARAMS_VERSION = "level@2.0.0";
const DEFAULTS = {
  offsetPct:    null,   // null → per-asset-class (lib.OFFSET_BY_CLASS)
  nearMissPct:  0.12,   // came this close and turned = a MISS worth knowing about
  rejectWickAtr:0.35,   // max excursion BEYOND the level, in ATR, for a wick to be a rejection
  rejectNearAtr:0.60,   // the close must remain this near the level — else it is not a test of it
  touchPct:     0.05    // within this of the level counts as a touch
};

/**
 * @param {object} ctx {asset, tf, candles, levels:[{p,side,lbl,key}], state?}
 */
function run(ctx, params){
  const P = Object.assign({}, DEFAULTS, params || {});
  const { asset, tf } = ctx;
  const c = ctx.candles || [];
  const levels = (ctx.levels || []).filter(l => l && typeof l.p === "number");
  const out = [];
  if(c.length < 3 || !levels.length) return out;

  const OFF  = P.offsetPct == null ? offsetFor(asset) : P.offsetPct;
  const deb  = ctx.debouncer || (ctx.debouncer = new Debouncer({ cooldownMs: TF_MS[tf] || TF_MS["1H"] }));
  const A    = atr(c, 14);
  const last = c[c.length-1];
  const prev = c[c.length-2];
  ctx.touches = ctx.touches || {};

  const emit = (o) => {
    /* stamp the BAR TIME. Without this every event carried t=undefined and
       could never match a benchmark label in time — recall would read 0. */
    const e = makeEvent(Object.assign({ t:last.t, asset, tf, watcher:"level" }, o));
    const d = deb.check(e);
    if(!d.allow){ e.status="debounced"; e.evidence.debounce=d.reason; out.push(e); return; }
    deb.commit(e);
    out.push(e);
  };

  for(const L of levels){
    const lvl = L.p;
    const lbl = L.lbl || L.label || "";
    /* HYSTERESIS. Previously "approached from below" meant prev.c < lvl by ANY
       amount, so price hovering on a level re-broke it bar after bar. The prior
       close must now be clear of the level by the same offset the break requires
       — a true side change, not a wobble. This was the dominant noise source:
       242 breaks over 2,728 bars across 10 levels. */
    const o = OFF / 100;
    const wasBelow = prev.c < lvl * (1 - o);
    const wasAbove = prev.c > lvl * (1 + o);
    const vg = volumeGate(c);

    /* ---- 1 · BREAK on close, beyond the offset ---- */
    const brokeUp   = wasBelow && beyond(last.c, lvl, "up",   OFF);
    const brokeDown = wasAbove && beyond(last.c, lvl, "down", OFF);
    if(brokeUp || brokeDown){
      emit({
        type:"LEVEL_BREAK", level:lvl, tier:2,
        fact:`${tf} closed ${last.c} ${brokeUp?"above":"below"} ${lvl}${lbl?" ("+lbl.slice(0,60)+")":""}, `
           + `clearing the ${OFF}% offset`,
        evidence:{ close:last.c, level:lvl, direction:brokeUp?"up":"down",
                   offsetPct:OFF, volMult:vg.mult, label:lbl.slice(0,120) },
        confirm:{ basis:"close", tf, offsetPct:OFF, volMult:vg.mult, passed:vg.passed },
        /* volume grades the break, it does not veto the fact (le_014) */
        confidence: vg.passed === false ? 0.45 : vg.passed === true ? 0.85 : 0.65,
        affects:[`${asset}.levels`, `${asset}.bias`]
      });
      deb.rearm(asset, "LEVEL_REJECT", lvl);
      continue;
    }

    /* ---- 2 · REJECT: wick beyond, close back inside ----
       BUG FIXED after the first real replay. The allowance was
       `rejectWickAtr * 3` = 1.05 ATR, which made the parameter meaningless:
       on a daily BTC bar (ATR ~2,000) ANY level within 2,000 points below the
       high counted as "wicked beyond and rejected". That alone produced 810 of
       ~2,200 scoreable events — 78 rejections across 88 daily bars.

       A rejection means price pierced the level by a SMALL amount and closed
       back. Two constraints now: the excursion beyond must be ≤ rejectWickAtr
       of ATR, and the close must still be in the level's neighbourhood —
       otherwise the bar merely traded past a distant level. */
    const wickUp   = last.h - lvl;
    const wickDown = lvl - last.l;
    const near     = A ? Math.abs(last.c - lvl) <= A * P.rejectNearAtr : false;
    const rejUp    = wickUp   > 0 && last.c < lvl && A && near && wickUp   <= A * P.rejectWickAtr;
    const rejDown  = wickDown > 0 && last.c > lvl && A && near && wickDown <= A * P.rejectWickAtr;
    if(rejUp || rejDown){
      const w = rejUp ? wickUp : wickDown;
      emit({
        /* DEMOTED to tier-1 in Step 2c: 520 events, net edge +0.009 vs
           random — the single largest noise source, carrying no signal. */
        type:"LEVEL_REJECT", level:lvl, tier:1,
        fact:`${tf} wicked ${w.toFixed(4)} ${rejUp?"above":"below"} ${lvl} and closed back `
           + `${rejUp?"under":"over"} it at ${last.c}`,
        evidence:{ wick:rejUp?last.h:last.l, level:lvl, close:last.c,
                   wickBeyond:+w.toFixed(4), atrFraction:A?+(w/A).toFixed(2):null, label:lbl.slice(0,120) },
        confirm:{ basis:"wick+close", tf },
        confidence: A && w < A*P.rejectWickAtr ? 0.8 : 0.6,
        affects:[`${asset}.levels`]
      });
      continue;
    }

    /* ---- 3 · NEAR MISS — the operator's costliest leak ----
       Fires ONLY for KEY levels (the ones VAULT.analysis.levels[] marks
       key:true — planned entries, must-holds, structural pivots).
       This event exists to catch a missed PLANNED ENTRY (le_013: a zone
       missed by 6 points, forfeiting +4.2R). A near-miss of an arbitrary
       ladder level is not a missed entry — emitting it for every level
       turned the most important signal into the noisiest one. */
    const distPct = Math.min(Math.abs(last.h - lvl), Math.abs(last.l - lvl)) / lvl * 100;
    const reached = last.h >= lvl && last.l <= lvl;
    if(L.key === true && !reached && distPct <= P.nearMissPct){
      const from = last.h < lvl ? "below" : "above";
      emit({
        type:"LEVEL_TEST_MISSED", level:lvl, tier:2,
        fact:`${tf} came within ${distPct.toFixed(3)}% of ${lvl} from ${from} `
           + `(extreme ${from==="below"?last.h:last.l}) and turned without reaching it`,
        evidence:{ level:lvl, extreme:from==="below"?last.h:last.l, distancePct:+distPct.toFixed(4),
                   from, label:lbl.slice(0,120),
                   note:"zones written AT the level do not fill — see the 0.1% offset rule" },
        confirm:{ basis:"wick", tf },
        confidence:0.75,
        affects:[`${asset}.levels`]
      });
      continue;
    }

    /* ---- 4 · TOUCH accounting (per-level touch-%) ---- */
    if(Math.abs(last.h - lvl)/lvl*100 <= P.touchPct || Math.abs(last.l - lvl)/lvl*100 <= P.touchPct
       || (last.h >= lvl && last.l <= lvl)){
      const k = `${asset}|${lvl}`;
      ctx.touches[k] = (ctx.touches[k]||0)+1;
      emit({
        type:"TOUCH_COUNT", level:lvl, tier:1,          // T1 — bookkeeping, never wakes the agent
        fact:`${lvl} touched (count ${ctx.touches[k]})`,
        evidence:{ level:lvl, count:ctx.touches[k], label:lbl.slice(0,120) },
        confirm:{ basis:"touch", tf }, confidence:0.9,
        affects:[`${asset}.levels`]
      });
      /* deliberately NOT re-arming LEVEL_BREAK here — a touch is not a side
         change, and re-arming on touch is what let a level break repeatedly. */
    }
  }
  return out;
}

module.exports = { run, PARAMS_VERSION, DEFAULTS, id:"level" };
