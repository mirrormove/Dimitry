/* ============================================================
   DIMITRY · WATCHER SCORING HARNESS      Vault Intelligence v4
   Zero dependencies.

   THE PERMANENT GATE. Every watcher, and every future change to a
   watcher's parameters, is scored against the frozen calibration
   benchmark BEFORE deployment. Nothing graduates from shadow mode
   without passing here.

   First-class metrics (operator requirement, 2026-07-27):
     precision · recall · FPR · FNR · avg lead time · calibration (Brier)

   Usage
     const {scoreWatcher} = require("./calibration/score.js");
     scoreWatcher("structure", emittedEvents)      → metrics + verdict
     compareParams(baseline, candidate)            → regression check
   ============================================================ */
"use strict";
const fs   = require("fs");
const path = require("path");
const { EVENTS, QUIET_WINDOWS } = require("./labelled-events.js");

/* ---- promotion gate (spec §11) ----------------------------- */
const GATE = {
  precision: 0.80,   // ≥ 80% of emitted events must correspond to a real label
  recall:    0.70,   // ≥ 70% of labelled facts must be caught
  minSample: 20,     // per event type, before any gate is meaningful
  maxStormPerHour: 3
};

/* K2 — the identity of a STRUCTURE event (operator decision, 2026-07-28).
   A structure event is the SAME event when its type + direction + timeframe + timing
   window agree. Its exact PRICE is NOT the identity test — it is a SECONDARY QUALITY
   measure, recorded separately. This separates two questions the old gate conflated:
     (1) did Dimitry see the same structural EVENT?   ← identity, gates precision/recall
     (2) did it name the same important LEVEL?         ← quality, reported, never gates
   Rationale: the analyst names the level they care about ($65,000); the detector names
   the level it discovered ($65,180); a +0.28% deviation is a good detection of the same
   BOS, not a miss. Demanding an exact match manufactured recall 0. */
const LEVEL_TOL_PCT   = 0.15;   // "entry-usable" quality threshold — NOT the identity gate
const EPISODE_MAX_PCT = 3.0;    // loose same-episode sanity bound (stops a $63k event matching a $67k one)
/* Time tolerance by timeframe, in ms — one bar either side. */
const TF_MS = { "5m":3e5, "15m":9e5, "30m":18e5, "1H":36e5, "4H":144e5, "1D":864e5, "1W":6048e5 };
const tfWindow = tf => (TF_MS[tf] || 864e5) * 1.0;

const pct = (a,b) => b ? Math.abs(a-b)/Math.abs(b)*100 : (a===b?0:Infinity);

/* Best-effort direction for an event, from its own evidence, its words, then its type.
   Returns "up" | "down" | null. Null means "unknown" — never used to force a mismatch. */
function eventDirection(e){
  const raw = e.evidence && (e.evidence.direction || e.evidence.dir);
  const d = raw ? String(raw).toLowerCase() : (e.dir ? String(e.dir).toLowerCase() : "");
  if(/^(up|bull|long)/.test(d)) return "up";
  if(/^(down|bear|short)/.test(d)) return "down";
  const txt = String(e.fact || "").toLowerCase();
  if(/reclaim|\bheld\b|flip|bullish|bull case|golden.?zone long|swept.*reclaim|higher.?low/.test(txt)) return "up";
  if(/breakdown|broke down|bearish|rejection|rejected|lost the|lower.?high|failed bull/.test(txt)) return "down";
  switch(e.type){
    case "SWEEP_RECLAIM": case "FLIP_CONFIRMED": case "LEVEL_RECLAIM": return "up";
    case "OB_REJECTION":  case "LEVEL_REJECT":   return "down";
    default: return null;                        // BOS/CHoCH/OB_MITIGATED/FVG carry no sign without evidence
  }
}

/** Does an emitted event match a labelled one? Identity = type+dir+tf+timing (K2).
    @param {object} opts {strictLevel} — strictLevel:true restores the old 0.15% price gate,
                          used only to A/B the K2 change against the frozen baseline. */
function matches(emitted, label, opts){
  opts = opts || {};
  if(!Number.isFinite(emitted.t)) return false;   // an unstamped event can never match
  if(emitted.asset !== label.asset) return false;
  /* timeframe must match: a 1H break and a 1D break are different claims. */
  if(emitted.tf && label.tf && emitted.tf !== label.tf) return false;
  const win = tfWindow(label.tf);
  if(Math.abs(emitted.t - label.t) > win) return false;
  /* SAFEGUARD 1 · direction must agree when BOTH are known. A missing direction never
     forces a mismatch (that would re-introduce a data gap as a false miss). */
  const de = eventDirection(emitted), dl = eventDirection(label);
  if(de && dl && de !== dl) return false;
  /* SAFEGUARD 2 · a loose same-episode price bound — not the 0.15% identity gate,
     just enough that a genuinely different level is not called the same event. */
  const dev = (label.level != null && emitted.level != null) ? pct(emitted.level, label.level) : 0;
  if(dev > (opts.strictLevel ? LEVEL_TOL_PCT : EPISODE_MAX_PCT)) return false;
  // type may be an exact match or a declared alias
  if(emitted.type === label.type) return true;
  const ALIAS = {
    LEVEL_BREAK:   ["LEVEL_RECLAIM","BOS_CONFIRMED"],
    BOS_CONFIRMED: ["LEVEL_BREAK"],
    SWEEP:         ["SWEEP_RECLAIM"],
    SWEEP_RECLAIM: ["SWEEP"],
    LEVEL_REJECT:  ["OB_REJECTION"],
    OB_REJECTION:  ["LEVEL_REJECT"]
  };
  return (ALIAS[label.type] || []).includes(emitted.type);
}

function inQuietWindow(e){
  return QUIET_WINDOWS.some(q => e.asset === q.asset && e.t >= q.from && e.t <= q.to);
}

/**
 * Score one watcher's emitted events against the benchmark.
 * @param {string} watcherId
 * @param {Array}  emitted  [{t, asset, type, tf, level, confidence?}]
 * @param {object} opts     {includeSoft:false, asset:null}
 */
/* A timeframe is SCOREABLE only if the benchmark labels it densely enough to
   judge a miss. BTC has 16 labels on 1D, 11 on 4H, 9 on 1H — but only 3 on 15m
   across 8,447 bars. Scoring 15m emissions as false positives would penalise the
   detector using ground truth that does not exist: the analyses simply never
   worked at that resolution. Those emissions are reported as UNSCOREABLE. */
const MIN_LABELS_PER_TF = 5;

function scoreWatcher(watcherId, emitted, opts){
  opts = opts || {};
  let labels = EVENTS.filter(e => e.watcher === watcherId);
  if(!opts.includeSoft) labels = labels.filter(e => e.detectability === "hard");
  if(opts.asset){ labels = labels.filter(e => e.asset === opts.asset);
                  emitted = emitted.filter(e => e.asset === opts.asset); }

  /* BUG FIX 1 — labels for assets that were never replayed are UNREACHABLE.
     Counting them as misses understates recall and blames the detector for
     data it was never given. */
  let unreachable = [];
  if(opts.scopeAssets && opts.scopeAssets.length){
    const inScope = new Set(opts.scopeAssets);
    unreachable = labels.filter(l => !inScope.has(l.asset));
    labels  = labels.filter(l => inScope.has(l.asset));
    emitted = emitted.filter(e => inScope.has(e.asset));
  }

  /* BUG FIX 2 — restrict scoring to timeframes the benchmark actually covers. */
  const tfCount = {};
  labels.forEach(l => tfCount[l.tf] = (tfCount[l.tf]||0)+1);
  const scoreableTfs = new Set(Object.keys(tfCount).filter(tf => tfCount[tf] >= MIN_LABELS_PER_TF));
  const unscoreable = emitted.filter(e => e.tf && !scoreableTfs.has(e.tf));
  labels  = labels.filter(l => scoreableTfs.has(l.tf));
  emitted = emitted.filter(e => !e.tf || scoreableTfs.has(e.tf));

  const usedEmit = new Set();
  const tp = [], fn = [];

  for(const L of labels){
    const hit = emitted.find((e,i) => !usedEmit.has(i) && matches(e, L, opts) && (usedEmit.add(i), true));
    if(hit){
      const devPct = (L.level != null && hit.level != null) ? pct(hit.level, L.level) : null;
      tp.push({ label:L, emitted:hit, leadMs: L.t - hit.t, levelDevPct: devPct==null?null:+devPct.toFixed(3),
                dirVerified: !!(eventDirection(hit) && eventDirection(L)) });
    }
    else fn.push(L);
  }
  const fp = emitted.filter((_,i) => !usedEmit.has(i));
  const fpQuiet = fp.filter(inQuietWindow);          // fired where the record says nothing happened

  const P = tp.length + fp.length;
  const precision = P ? tp.length / P : null;
  const recall    = labels.length ? tp.length / labels.length : null;
  const fpr       = P ? fp.length / P : null;
  const fnr       = labels.length ? fn.length / labels.length : null;

  /* LEAD TIME — forward labels only.
     A label sourced from a note written on or after the event day was recorded
     with hindsight; "how early did the detector fire" against it is meaningless.
     Only 2 of 61 benchmark labels are forward, so this is reported as
     INSUFFICIENT and accumulates forward from shadow-mode running instead. */
  const fwd  = tp.filter(x => x.label.forward);
  const leads = fwd.map(x => x.leadMs / 36e5).sort((a,b)=>a-b);          // hours
  const median = leads.length ? leads[Math.floor(leads.length/2)] : null;
  const avgLeadH = leads.length ? leads.reduce((a,b)=>a+b,0)/leads.length : null;
  const leadStatus = leads.length >= 10 ? "measured"
                   : leads.length > 0   ? `insufficient (n=${leads.length}, need 10) — accumulate in shadow`
                   : "not measurable from this benchmark — accumulate in shadow";

  /* Brier: only meaningful if the watcher publishes a confidence per event */
  const withConf = tp.concat(fp.map(e=>({emitted:e, label:null})))
                     .filter(x => typeof x.emitted.confidence === "number");
  const brier = withConf.length
    ? withConf.reduce((s,x)=> s + Math.pow(x.emitted.confidence - (x.label?1:0), 2), 0) / withConf.length
    : null;

  /* storm rate: max events per asset per rolling hour */
  let storm = 0;
  const byAsset = {};
  emitted.forEach(e => (byAsset[e.asset] = byAsset[e.asset] || []).push(e.t));
  Object.values(byAsset).forEach(ts => {
    ts.sort((a,b)=>a-b);
    for(let i=0;i<ts.length;i++){
      const n = ts.filter(t => t >= ts[i] && t < ts[i] + 36e5).length;
      if(n > storm) storm = n;
    }
  });

  /* LEVEL QUALITY (K2 · question 2) — of the events we DID match, how close was the
     detector's price to the analyst's? This is reported, never gated: it answers
     "did it name the same level?" separately from "did it see the same event?". */
  const devs = tp.map(x => x.levelDevPct).filter(d => d != null).sort((a,b)=>a-b);
  const withinTol = devs.filter(d => d <= LEVEL_TOL_PCT).length;
  const levelQuality = devs.length ? {
    n: devs.length,
    medianDevPct: +devs[Math.floor(devs.length/2)].toFixed(3),
    meanDevPct:   +(devs.reduce((a,b)=>a+b,0)/devs.length).toFixed(3),
    maxDevPct:    +devs[devs.length-1].toFixed(3),
    entryUsable:  +(withinTol/devs.length).toFixed(3),      // fraction within 0.15% (usable for an entry)
    entryUsableCount: withinTol
  } : null;
  const dirVerified = tp.filter(x => x.dirVerified).length;

  const sample = labels.length;
  const reasons = [];
  if(sample < GATE.minSample)            reasons.push(`sample ${sample} < ${GATE.minSample} — gate not yet meaningful`);
  if(precision != null && precision < GATE.precision) reasons.push(`precision ${(precision*100).toFixed(0)}% < ${GATE.precision*100}%`);
  if(recall != null && recall < GATE.recall)          reasons.push(`recall ${(recall*100).toFixed(0)}% < ${GATE.recall*100}%`);
  if(storm > GATE.maxStormPerHour)       reasons.push(`storm ${storm}/h > ${GATE.maxStormPerHour}/h`);
  if(fpQuiet.length)                     reasons.push(`${fpQuiet.length} event(s) fired inside a negative-control window`);

  const pass = reasons.length === 0;
  return {
    watcher: watcherId,
    verdict: pass ? "PASS — may graduate from shadow" : "HOLD IN SHADOW",
    reasons,
    metrics: {
      sample, tp: tp.length, fp: fp.length, fn: fn.length,
      precision, recall, fpr, fnr,
      avgLeadH: avgLeadH == null ? null : +avgLeadH.toFixed(2),
      medianLeadH: median == null ? null : +median.toFixed(2),
      leadStatus, leadSample: leads.length, forwardLabels: labels.filter(l=>l.forward).length,
      brier, stormPerHour: storm,
      falsePositivesInQuietWindows: fpQuiet.length,
      scoreableTfs: [...scoreableTfs], unscoreableEmissions: unscoreable.length,
      unreachableLabels: unreachable.length,
      levelQuality,                              // K2 question 2: did it name the same level?
      directionVerifiedTP: dirVerified,          // of TPs, how many had direction confirmed both sides
      identityRule: opts.strictLevel ? "strict-price (legacy 0.15%)" : "K2: type+direction+timeframe+timing"
    },
    matchedEmittedIds: tp.map(x => x.emitted.id).filter(Boolean),
    missed: fn.map(f => ({ id:f.id, type:f.type, asset:f.asset, level:f.level, fact:f.fact.slice(0,90) })),
    falsePositives: fp.slice(0,10).map(e => ({ t: Number.isFinite(e.t) ? new Date(e.t).toISOString() : null,
                                               asset:e.asset, type:e.type, level:e.level }))
  };
}

/**
 * Regression check: no parameter change ships if it degrades the benchmark.
 * (Operator requirement: "Every future change to watcher parameters should be
 *  evaluated against that benchmark before deployment.")
 */
function compareParams(watcherId, baselineEmitted, candidateEmitted, opts){
  const a = scoreWatcher(watcherId, baselineEmitted, opts);
  const b = scoreWatcher(watcherId, candidateEmitted, opts);
  const d = (k) => (b.metrics[k] == null || a.metrics[k] == null) ? null
                 : +(b.metrics[k] - a.metrics[k]).toFixed(4);
  const deltas = { precision:d("precision"), recall:d("recall"),
                   fpr:d("fpr"), stormPerHour:d("stormPerHour") };
  const regressed = (deltas.precision != null && deltas.precision < -0.02)
                 || (deltas.recall    != null && deltas.recall    < -0.02)
                 || (deltas.stormPerHour != null && deltas.stormPerHour > 0);
  return { watcher:watcherId, baseline:a.metrics, candidate:b.metrics, deltas,
           verdict: regressed ? "REJECT — regresses the benchmark" : "ACCEPT",
           note: regressed ? "A parameter change may not degrade precision/recall by >2pp or raise the storm rate."
                           : "No regression against the frozen benchmark." };
}

/** Coverage of the benchmark itself — what CAN be scored today. */
function benchmarkCoverage(){
  const byWatcher = {}, byAsset = {}, byType = {};
  for(const e of EVENTS){
    const w = byWatcher[e.watcher] = byWatcher[e.watcher] || { hard:0, soft:0 };
    w[e.detectability]++;
    byAsset[e.asset] = (byAsset[e.asset]||0)+1;
    byType[e.type]   = (byType[e.type]||0)+1;
  }
  return { events:EVENTS.length, quietWindows:QUIET_WINDOWS.length, byWatcher, byAsset, byType,
           gate:GATE, levelTolPct:LEVEL_TOL_PCT };
}

if(require.main === module){
  const cov = benchmarkCoverage();
  console.log("CALIBRATION BENCHMARK — coverage\n");
  console.log(`labelled events : ${cov.events}   (negative-control windows: ${cov.quietWindows})`);
  console.log(`level tolerance : ±${cov.levelTolPct}%   gate: precision ≥${GATE.precision*100}% · recall ≥${GATE.recall*100}% · min sample ${GATE.minSample}\n`);
  console.log("by watcher (hard = must-catch, soft = judgement):");
  Object.entries(cov.byWatcher).forEach(([k,v]) =>
    console.log(`  ${k.padEnd(12)} hard ${String(v.hard).padStart(2)}   soft ${String(v.soft).padStart(2)}   ${v.hard>=GATE.minSample?"✓ gateable":"— needs "+(GATE.minSample-v.hard)+" more hard labels"}`));
  console.log("\nby asset:");
  Object.entries(cov.byAsset).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log(`  ${k.padEnd(9)} ${v}`));
  console.log("\nby event type:");
  Object.entries(cov.byType).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log(`  ${k.padEnd(20)} ${v}`));

  /* self-test: a PERFECT detector must score 1.0, and a NOISY one must fail.
     If these two do not behave, the harness itself is broken. */
  console.log("\n── harness self-test ──");
  const hard = EVENTS.filter(e=>e.watcher==="level"&&e.detectability==="hard");
  const perfect = hard.map(e=>({t:e.t, asset:e.asset, type:e.type, tf:e.tf, level:e.level, confidence:0.9}));
  const r1 = scoreWatcher("level", perfect);
  console.log(`  perfect detector : precision ${(r1.metrics.precision*100).toFixed(0)}%  recall ${(r1.metrics.recall*100).toFixed(0)}%  → ${r1.verdict.split("—")[0].trim()}`);
  const noisy = perfect.concat(Array.from({length:15},(_,i)=>({
    t:Date.parse("2026-07-12T00:00:00Z")+i*6e5, asset:"BTCUSDT", type:"LEVEL_BREAK", tf:"1H", level:62000+i, confidence:0.8 })));
  const r2 = scoreWatcher("level", noisy);
  console.log(`  noisy detector   : precision ${(r2.metrics.precision*100).toFixed(0)}%  storm ${r2.metrics.stormPerHour}/h  quiet-window FPs ${r2.metrics.falsePositivesInQuietWindows}  → ${r2.verdict}`);
  console.log(`  reasons: ${r2.reasons.join(" · ")}`);
}

module.exports = { scoreWatcher, compareParams, benchmarkCoverage, GATE, matches, eventDirection };
