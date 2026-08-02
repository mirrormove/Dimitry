/* ============================================================
   THE ASCENT ENGINE      Vault Intelligence v4 · Self-Improvement
   Zero dependencies.

   Dimitry measuring itself, with NO CEILING. It reads its own quality axes
   (self-model-data.js) + the measured record (base-rates.json), remembers the
   best it has ever reached on each ("barriers"), and compounds an
   EXPONENTIAL QUOTIENT (EQ) from how much it improves each cycle.

   THE MATH THAT MAKES "NO PEAK" REAL.
   For a BOUNDED axis (accuracy, calibration ∈ [0,1]) improvement is the fraction
   of the REMAINING gap closed:  imp = (v − v_prev) / (1 − v_prev).
   Closing the last 5% is as hard as the first 50%, so a positive rate can be
   sustained forever without ever finishing — perpetual, asymptotic, exponential.
   For an UNBOUNDED axis (realised R, frequency) improvement is the growth rate.

   EQ is a compounding index (starts at 100): EQ *= 1 + Σ preference·imp. Its
   slope on a log scale IS the exponential rate of self-improvement. A flat cycle
   holds it; a regression dips it — instantly visible.

   GOALS ARE SELF-SET, by the preference scale × headroom, and every target sits
   strictly SHORT of the ideal — so there is always a next barrier to break.

   Run:  node calibration/ascent.js
   ============================================================ */
"use strict";
const fs   = require("fs");
const path = require("path");
const { AXES, processLeaks } = require("./self-model-data.js");

const HERE = __dirname;
const TOOLS = path.resolve(HERE, "..", "..");
const BR_JSON = path.resolve(TOOLS, "base-rates.json");
const STATE   = path.resolve(TOOLS, "self-model.json");     // append-only self-history

const CLIP = 0.5;                 // per-axis improvement clip, so one axis can't whipsaw EQ
const GAP_STRETCH = 0.25;         // bounded goal closes a quarter of the remaining gap
const GROW_STRETCH = 0.15;        // unbounded goal targets +15%
const clamp = (x,a,b) => Math.max(a, Math.min(b, x));

/* Operator refinement (2026-08-01): self-improvement is a MEANS, not an end.
   Improve UNTIL the setup is EFFICIENT, then stop tinkering and ride CONSISTENCY —
   and let the EQ compound on PROFITABILITY, not on chasing more metrics.
   Profitability outranks self-improvement, always. */
const DEFAULT_EFF_THRESHOLD = 0.90;   // "unquestionably profitable and efficient" (operator dial)
const EFF_WEIGHTS = { modelAccuracy:0.30, accuracy:0.30, precision:0.20, setupQuality:0.20 };
const CONSISTENCY_TICK = 0.003;       // holding the efficient lane compounds the EQ modestly, per cycle

/** Current values per axis, from the measured record + the process-leak ledger.
    null = not yet measurable (honest) — never a fabricated number. */
function snapshot(baseRates, leaks){
  const P = baseRates && baseRates.portfolio;
  const rate = (num, den) => den > 0 ? num/den : null;
  const impLeak = rate(leaks.impulsivity.impulsiveEntries, leaks.impulsivity.opportunities);
  const timLeak = rate(leaks.timidity.skippedEarnedSetups + leaks.timidity.winnersCutEarly,
                       leaks.timidity.earnedOpportunities);
  return {
    modelAccuracy: null,                        // needs forward calibration to measure
    accuracy:      P ? P.winRate : null,        // portfolio win-of-filled
    precision:     null,                        // needs per-call level-quality accumulation
    setupQuality:  P ? P.avgRfilled : null,     // realised R / filled (unbounded)
    timidityGuard: timLeak == null ? null : 1 - timLeak,
    frequency:     null,                        // needs a baseline period
    impulsivityGuard: impLeak == null ? null : 1 - impLeak
  };
}

/**
 * One ascent step. Pure: history + new snapshot → the full self-model result.
 * @param {Array}  history  prior results (each has .snapshot, .barriers, .eq)
 * @param {object} snap     axisId → value|null
 * @param {object} opts     {axes, now}
 */
function ascend(history, snap, opts){
  opts = opts || {};
  const axes = opts.axes || AXES;
  const prev = history.length ? history[history.length-1] : null;
  const prevSnap = prev ? prev.snapshot : {};
  const prevBar  = prev ? prev.barriers : {};
  const eqPrev   = prev && typeof prev.eq === "number" ? prev.eq : 100;

  const perAxis = [], barriers = {}, broken = [], goals = [];

  for(const ax of axes){
    const v  = snap[ax.id];
    const vp = prevSnap[ax.id];
    const bestPrev = prevBar[ax.id] != null ? prevBar[ax.id] : (vp != null ? vp : null);

    /* barrier (personal best) — no ceiling: it only ever ratchets up */
    let best = bestPrev;
    let brokeBarrier = false;
    if(v != null){
      if(best == null || v > best + 1e-9){ if(best != null) { brokeBarrier = true; broken.push({ axis:ax.id, from:+best.toFixed(4), to:+v.toFixed(4) }); } best = v; }
    }
    barriers[ax.id] = best != null ? +best.toFixed(4) : null;

    /* improvement this cycle */
    let imp = null;
    if(v != null && vp != null){
      imp = ax.bound
          ? (vp < 1 ? (v - vp) / (1 - vp) : 0)          // fraction of remaining gap closed
          : (Math.abs(vp) > 1e-9 ? (v - vp) / Math.abs(vp) : 0);  // growth rate
      imp = clamp(imp, -CLIP, CLIP);
    }

    /* self-set goal — always strictly short of the ideal (perpetual) */
    let target = null, headroom;
    if(v == null){
      target = null; headroom = 1;                       // unmeasured → maximal headroom ("measure me")
    } else if(ax.bound){
      const base = best != null ? best : v;
      target = base + GAP_STRETCH * (1 - base);          // < 1 always
      headroom = 1 - v;
    } else {
      const base = best != null ? best : v;
      target = base * (1 + GROW_STRETCH);
      headroom = 0.5;                                    // unbounded always has room
    }
    const priority = ax.preference * headroom;

    perAxis.push({ id:ax.id, label:ax.label, value:v==null?null:+ (ax.bound?v.toFixed(4):v.toFixed(3)),
                   prev: vp==null?null:+(ax.bound?vp.toFixed(4):vp.toFixed(3)),
                   improvement: imp==null?null:+imp.toFixed(4), brokeBarrier,
                   best: barriers[ax.id], measured: v!=null });
    goals.push({ id:ax.id, label:ax.label, target: target==null?null:+(ax.bound?target.toFixed(4):target.toFixed(3)),
                 priority:+priority.toFixed(4), preference:ax.preference,
                 status: v==null?"UNMEASURED — establish the baseline":"active", ceiling:null });
  }

  /* ---- EFFICIENCY & MODE — the graduation from improvement to consistency ---- */
  const effThreshold = opts.efficiencyThreshold != null ? opts.efficiencyThreshold : DEFAULT_EFF_THRESHOLD;
  let effNum=0, effDen=0, effCount=0;
  for(const [id,w] of Object.entries(EFF_WEIGHTS)){
    const v = snap[id]; if(v==null) continue;
    const nv = id==="setupQuality" ? Math.min(1, v/2.0) : v;   // +2R/filled ≈ fully efficient
    effNum += w*nv; effDen += w; effCount++;
  }
  const efficiency = effDen>0 ? +(effNum/effDen).toFixed(4) : null;
  const effSufficient = effCount >= 2;
  const graduated = efficiency!=null && effSufficient && efficiency >= effThreshold;
  const mode = graduated ? "consistency" : "improvement";
  const prevStreak = (prev && prev.consistencyStreak) || 0;
  const consistencyStreak = mode==="consistency" ? prevStreak+1 : 0;
  const profitR     = opts.profitability && opts.profitability.expectancyR;
  const prevProfitR = prev && prev.profitability && prev.profitability.expectancyR;

  /* ---- EQ — the axis of ascent MIGRATES at graduation ----
     improvement: compound on quality gains (means to the end).
     consistency: stop tinkering — compound on PROFITABILITY held over time. */
  const contrib = perAxis.filter(a => a.improvement != null);
  let cycleGrowth = 0, eqBasis;
  if(mode === "improvement"){
    eqBasis = "quality-improvement";
    const prefSum = contrib.reduce((s,a) => s + (axes.find(x=>x.id===a.id).preference), 0);
    if(prefSum > 0) for(const a of contrib){
      cycleGrowth += (axes.find(x=>x.id===a.id).preference / prefSum) * a.improvement;
    }
  } else {
    /* CONSISTENCY: efficiency is (by construction) above the floor. Stop tinkering;
       compound on PROFITABILITY held over time — growth in expectancy, plus a modest
       tick for simply holding the efficient lane (that is the win now). */
    eqBasis = "profitability-consistency";
    const profGrowth = (profitR!=null && prevProfitR!=null && Math.abs(prevProfitR)>1e-9)
      ? clamp((profitR - prevProfitR)/Math.abs(prevProfitR), -CLIP, CLIP) : 0;
    cycleGrowth = profGrowth + (profitR==null || profitR>0 ? CONSISTENCY_TICK : 0);
  }
  /* fell OUT of the efficient lane (was consistency, now improvement) — a regression to fix */
  const slipped = mode==="improvement" && prev && prev.mode==="consistency";
  const eq = +(eqPrev * (1 + cycleGrowth)).toFixed(3);

  /* ---- GOALS reorder by mode: in consistency, HOLD + COMPOUND outrank fiddling ---- */
  goals.sort((a,b) => b.priority - a.priority);
  if(mode === "consistency"){
    goals.forEach(g => { if(g.status==="active"){ g.status = "sufficient — do not over-tinker"; g.priority = 0; } });
    goals.unshift(
      { id:"compoundProfit", label:"Compound profitability · extend the consistency streak", target:null, priority:1.0, status:"consistency", ceiling:null },
      { id:"holdEfficiency", label:`Hold efficiency ≥ ${(effThreshold*100).toFixed(0)}% (stay in the lane)`, target:effThreshold, priority:0.95, status:"consistency", ceiling:null });
  } else if(efficiency != null){
    goals.unshift({ id:"reachEfficiency", label:`Reach efficiency ${(effThreshold*100).toFixed(0)}% — the TARGET of improvement`,
      target:effThreshold, priority:1.0, status:`improving (now ${(efficiency*100).toFixed(0)}%)`, ceiling:null });
  }

  /* ---- self-awareness ---- */
  const measured = perAxis.filter(a=>a.measured).length;
  const stalls = contrib.filter(a => a.improvement <= 0).map(a=>a.id);
  const facts = [];
  facts.push(`MODE: ${mode.toUpperCase()}${mode==="consistency"?` (streak ${consistencyStreak})`:""} · efficiency ${efficiency==null?"—":(efficiency*100).toFixed(0)+"%"}/${(effThreshold*100).toFixed(0)}% · EQ compounds on ${eqBasis}.`);
  facts.push(`EQ ${eq} (${cycleGrowth>=0?"+":""}${(cycleGrowth*100).toFixed(2)}% this cycle) — ${cycleGrowth>0?"compounding":cycleGrowth<0?"regressed":"held"}.`);
  if(broken.length && mode==="improvement") facts.push(`Broke ${broken.length} barrier(s): ${broken.map(b=>`${b.axis} ${b.from}→${b.to}`).join(", ")}.`);
  if(mode==="consistency") facts.push(`Efficient — do NOT over-tinker; the win is now staying profitable, not chasing metrics.`);
  else if(slipped) facts.push(`⚠ FELL OUT of the efficient lane — efficiency ${(efficiency*100).toFixed(0)}% < ${(effThreshold*100).toFixed(0)}%. Regression to fix before anything else.`);
  else if(stalls.length) facts.push(`Stalling on: ${stalls.join(", ")}.`);
  const unmeasured = perAxis.filter(a=>!a.measured).map(a=>a.id);
  if(unmeasured.length && mode==="improvement") facts.push(`Not yet measurable (top self-set goals): ${unmeasured.join(", ")}.`);
  facts.push(`Priority order: profitability › self-improvement. ${mode==="consistency"?"Consistency is the goal.":"Improve only until efficient."}`);

  return {
    at: opts.now || Date.now(),
    eq, eqPrev, cycleGrowth:+cycleGrowth.toFixed(4), eqBasis,
    mode, efficiency, efficiencyThreshold:effThreshold, consistencyStreak,
    profitability: opts.profitability || null,
    measuredAxes: measured, totalAxes: axes.length,
    snapshot: snap, perAxis, barriers, barriersBroken: broken,
    goals, ceiling: null,
    reflection: mode==="consistency"
      ? "Graduated to the CONSISTENCY lane. The setup is efficient — stop tinkering. No ceiling on profitability held over time; a ceiling on fiddling. Profitability › self-improvement."
      : "Improve until efficient — the target of the climb is a working setup (efficiency ≥ threshold), not infinite metrics. Self-improvement serves profitability, never the reverse.",
    selfAwareness: facts
  };
}

/** per-signal expectancy (R) from the measured record — the profitability signal. */
function profitabilityFrom(br){
  const P = br && br.portfolio; if(!P) return null;
  const perFilled = P.winRate*P.avgRfilled - (1-P.winRate)*1;
  return { expectancyR: +(P.triggerRate*perFilled).toFixed(3), avgRfilled:P.avgRfilled, totalR:P.totalR };
}

function main(){
  let br = null, hist = [];
  try { br = JSON.parse(fs.readFileSync(BR_JSON,"utf8")); } catch(e){}
  try { hist = JSON.parse(fs.readFileSync(STATE,"utf8")).history || []; } catch(e){}
  const snap = snapshot(br, processLeaks);
  const efficiencyThreshold = (typeof self_efficiency_threshold==="number") ? self_efficiency_threshold : undefined;
  const res  = ascend(hist, snap, { now: Date.now(), profitability: profitabilityFrom(br), efficiencyThreshold });
  hist.push({ at:res.at, snapshot:res.snapshot, barriers:res.barriers, eq:res.eq,
              mode:res.mode, efficiency:res.efficiency, consistencyStreak:res.consistencyStreak, profitability:res.profitability });
  fs.writeFileSync(STATE, JSON.stringify({ updated:res.at, history:hist }, null, 2));
  console.log(`ASCENT — MODE ${res.mode.toUpperCase()} · efficiency ${res.efficiency==null?"—":(res.efficiency*100).toFixed(0)+"%"} · EQ ${res.eq} (${(res.cycleGrowth*100).toFixed(2)}%, ${res.eqBasis})`);
  res.selfAwareness.forEach(f => console.log("  · " + f));
  console.log("  top goals:");
  res.goals.slice(0,4).forEach(g => console.log(`     ${(g.priority||0).toFixed(3)}  ${g.label}`));
}
let self_efficiency_threshold;
try { self_efficiency_threshold = require("./self-model-data.js").efficiencyThreshold; } catch(e){}

if(require.main === module) main();
module.exports = { snapshot, ascend, AXES, profitabilityFrom };
