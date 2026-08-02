/* ============================================================
   REPLAY ENGINE              Vault Intelligence v4 · Step 1
   Zero dependencies.

   ONE CODE PATH, two modes — so what you validate is what you deploy:
     backtest  candles from the disk cache   (this file, default)
     live      candles from the feed         (same replayCore, called by the daemon)

   Replays bar-by-bar with NO LOOKAHEAD: at bar i the watcher sees
   candles[0..i] and nothing after. Then scores against the frozen
   [[Calibration Benchmark]] and writes the graduation report.

   Run:  node replay/replay.js            (BTC, all cached TFs)
         node replay/replay.js XAUUSD
   ============================================================ */
"use strict";
const fs   = require("fs");
const path = require("path");
const S = require("../watchers/structure.js");
const L = require("../watchers/level.js");
const { Debouncer, TF_MS } = require("../watchers/lib.js");
const { scoreWatcher, benchmarkCoverage, GATE } = require("../calibration/score.js");
const { EVENTS } = require("../calibration/labelled-events.js");

const TOOLS = path.resolve(__dirname, "..", "..");
const CACHE = path.join(TOOLS, "klines");
const OUT_J = path.join(TOOLS, "replay-report.json");
const OUT_M = path.join(TOOLS, "replay-report.md");
const CALIB = path.join(TOOLS, "calibration.json");

/* ---- the ladder each Level-watcher run is given ----------------
   Taken from the levels the analyses themselves published, so the
   watcher is tested against the same ladder the operator traded.   */
function laddersFor(asset){
  const byAsset = {};
  for(const e of EVENTS){
    if(e.level == null) continue;
    (byAsset[e.asset] = byAsset[e.asset] || new Set()).add(e.level);
  }
  const real = [...(byAsset[asset] || [])].sort((a,b)=>b-a);
  if(!real.length) return [];

  /* DECOY LEVELS — without these, precision is structurally inflated.
     If the ladder contains ONLY levels that are also benchmark labels, the
     watcher can never fire at an uninteresting level, so false positives are
     undercounted by construction. In production the ladder holds ~10 levels,
     most of which never become events. Decoys are plausible round numbers
     across the same range that were NOT labelled — firing at one is a
     genuine false positive and is scored as such. */
  const hi = Math.max(...real), lo = Math.min(...real);
  const step = asset === "BTCUSDT" ? 500 : asset === "XAUUSD" ? 25 : 0.005;
  const decoys = [];
  for(let p = Math.ceil(lo/step)*step; p <= hi; p += step){
    const v = +p.toFixed(6);
    if(real.some(r => Math.abs(r - v)/v*100 < 0.3)) continue;   // too close to a real level
    decoys.push(v);
  }
  return real.map(p => ({ p, lbl:"benchmark level", decoy:false, key:true }))
    .concat(decoys.map(p => ({ p, lbl:"decoy (round number, never a labelled event)", decoy:true, key:false })))
    .sort((a,b) => b.p - a.p);
}

/* ---- THE CORE — shared by backtest and live ------------------- */
function replayCore({ asset, tf, candles, levels, warmup }){
  /* warmup must not swallow the early benchmark labels: on a short 1D series a
     flat 30 bars silently skipped every June label and reported them as misses. */
  warmup = warmup != null ? warmup : Math.min(30, Math.max(6, Math.floor(candles.length * 0.15)));
  const emitted = [];
  /* cooldown must scale with the timeframe — a flat 1h never blocks anything
     on 4H/1D bars, which silently disabled the debouncer on the higher TFs. */
  const cd = TF_MS[tf] || 36e5;
  const sCtx = { asset, tf, debouncer:new Debouncer({ cooldownMs: cd }) };
  const lCtx = { asset, tf, levels, debouncer:new Debouncer({ cooldownMs: cd }), touches:{} };

  /* REALISTIC LADDER DENSITY.
     In production the Level watcher receives VAULT.analysis.levels[] — 8-11
     levels around the working range. The benchmark's full level set is ~37,
     which is 4x denser: almost every bar then interacts with something and
     precision collapses for a reason that is an artifact of the test rig,
     not the detector. So each bar sees only the LADDER_N levels nearest to
     price, which is what a real ladder is. */
  const LADDER_N = 10;
  for(let i = warmup; i < candles.length; i++){
    const window = candles.slice(Math.max(0, i - 300), i + 1);   // NO LOOKAHEAD
    const px = candles[i].c;
    sCtx.candles = window;
    lCtx.candles = window;
    lCtx.levels = (levels || []).slice()
      .sort((a,b) => Math.abs(a.p - px) - Math.abs(b.p - px))
      .slice(0, LADDER_N);
    for(const e of S.run(sCtx)) if(e.status !== "debounced") emitted.push(e);
    for(const e of L.run(lCtx)) if(e.status !== "debounced") emitted.push(e);
  }
  return emitted;
}

/* ---- metrics beyond the gate --------------------------------- */
function calibrationCurve(emitted, labels){
  /* bin by published confidence, measure the realised hit-rate in each bin.
     A well-calibrated detector's curve tracks the diagonal.            */
  const bins = [[0,.5],[.5,.6],[.6,.7],[.7,.8],[.8,.9],[.9,1.01]];
  const matched = new Set();
  const hit = e => labels.some(l => l.asset===e.asset && l.level!=null && e.level!=null &&
                    Math.abs(e.level-l.level)/l.level*100 <= 0.15 &&
                    Math.abs(e.t-l.t) <= 864e5);
  return bins.map(([lo,hi]) => {
    const inBin = emitted.filter(e => e.confidence != null && e.confidence >= lo && e.confidence < hi);
    const hits  = inBin.filter(hit).length;
    return { bin:`${lo.toFixed(2)}–${hi>1?"1.00":hi.toFixed(2)}`, n:inBin.length,
             stated:+(((lo+Math.min(hi,1))/2)).toFixed(2),
             realised: inBin.length ? +(hits/inBin.length).toFixed(3) : null };
  });
}
function confidenceHistogram(emitted){
  const h = {};
  emitted.forEach(e => { const k = e.confidence==null ? "null" : e.confidence.toFixed(2); h[k]=(h[k]||0)+1; });
  return h;
}
function fpClusters(fps){
  /* where does the noise concentrate — by day and by level band */
  const byDay = {}, byType = {};
  for(const e of fps){
    const d = new Date(e.t).toISOString().slice(0,10);
    byDay[d] = (byDay[d]||0)+1;
    byType[e.type] = (byType[e.type]||0)+1;
  }
  const worstDays = Object.entries(byDay).sort((a,b)=>b[1]-a[1]).slice(0,5)
                      .map(([d,n])=>({ day:d, n }));
  return { byType, worstDays, total:fps.length };
}
function regimePerformance(emitted, asset){
  /* join to the benchmark's CONCLUSION records, which preserved the regime
     each day was analysed under — the payoff for keeping context, not just outcomes */
  let calib = null;
  try { calib = JSON.parse(fs.readFileSync(CALIB, "utf8")); } catch(e){ return null; }
  const byDay = {};
  for(const c of calib.conclusions){
    if(c.asset !== asset || !c.context.regime) continue;
    const r = /washout|oversold|capitulat/i.test(c.context.regime) ? "washout"
            : /range|chop|trendless|coil/i.test(c.context.regime)  ? "range"
            : /bounce|recovery|repair/i.test(c.context.regime)     ? "recovery"
            : /bear|decline|breakdown/i.test(c.context.regime)     ? "bear-trend"
            : /bull|breakout|rally/i.test(c.context.regime)        ? "bull-trend" : "other";
    byDay[c.date] = r;
  }
  const out = {};
  for(const e of emitted){
    const d = new Date(e.t).toISOString().slice(0,10);
    const r = byDay[d]; if(!r) continue;
    (out[r] = out[r] || { events:0, types:{} });
    out[r].events++;
    out[r].types[e.type] = (out[r].types[e.type]||0)+1;
  }
  return out;
}

/* ---- report -------------------------------------------------- */
function markdown(rep){
  const pc = v => v==null ? "—" : (v*100).toFixed(0)+"%";
  let m = `# Replay Report — watcher graduation\n\n`;
  m += `> Generated ${new Date(rep.generatedAt).toISOString().slice(0,16).replace("T"," ")}Z · `
     + `benchmark **${rep.benchmarkVersion}** · scope **${rep.assets.join(", ")}**\n\n`;
  m += `Bar-by-bar replay with no lookahead. Every watcher scored against the frozen `
     + `[[Calibration Benchmark]]. **No watcher graduates from shadow without passing here.**\n\n`;

  m += `## Data replayed\n\n| Asset | TF | Bars | From | To |\n|---|---|---|---|---|\n`;
  rep.series.forEach(s => m += `| ${s.asset} | ${s.tf} | ${s.bars} | ${s.from} | ${s.to} |\n`);

  m += `\n## Verdicts\n\n| Watcher | Verdict | Precision | Recall | Sample | Storm/h | Quiet-window FPs |\n|---|---|---|---|---|---|---|\n`;
  for(const r of rep.results){
    m += `| **${r.watcher}** | ${/PASS/.test(r.verdict)?"✅ PASS":"⬜ HOLD"} | ${pc(r.metrics.precision)} | `
       + `${pc(r.metrics.recall)} | ${r.metrics.sample} | ${r.metrics.stormPerHour} | ${r.metrics.falsePositivesInQuietWindows} |\n`;
  }
  for(const r of rep.results){
    m += `\n### ${r.watcher}\n\n`;
    m += `- TP **${r.metrics.tp}** · FP **${r.metrics.fp}** · FN **${r.metrics.fn}**\n`;
    m += `- FPR ${pc(r.metrics.fpr)} · FNR ${pc(r.metrics.fnr)} · Brier ${r.metrics.brier==null?"—":r.metrics.brier.toFixed(3)}\n`;
    m += `- Lead time: **${r.metrics.leadStatus}**${r.metrics.leadSample?` (n=${r.metrics.leadSample}, median ${r.metrics.medianLeadH}h)`:""}\n`;
    if(r.reasons.length) m += `- **Held because:** ${r.reasons.join(" · ")}\n`;
    if(r.missed && r.missed.length){
      m += `\n**Missed (false negatives) — the detector stayed silent:**\n\n`;
      r.missed.slice(0,10).forEach(x => m += `- \`${x.id}\` ${x.type} @ ${x.level} — ${x.fact}\n`);
    }
  }
  if(rep.calibration){
    m += `\n## Calibration curve\n\nStated confidence vs realised hit-rate. A well-calibrated detector tracks the diagonal.\n\n`;
    m += `| Confidence bin | n | Stated | Realised |\n|---|---|---|---|\n`;
    rep.calibration.forEach(b => m += `| ${b.bin} | ${b.n} | ${b.stated} | ${b.realised==null?"—":b.realised} |\n`);
  }
  if(rep.fpClusters){
    m += `\n## False-positive clusters\n\nTotal **${rep.fpClusters.total}**. By type: `
       + Object.entries(rep.fpClusters.byType).map(([k,v])=>`${k} ${v}`).join(" · ") + `\n\n`;
    if(rep.fpClusters.worstDays.length){
      m += `Worst days: ` + rep.fpClusters.worstDays.map(d=>`${d.day} (${d.n})`).join(" · ") + `\n`;
    }
  }
  if(rep.regime && Object.keys(rep.regime).length){
    m += `\n## Performance by market regime\n\n| Regime | Events | Dominant types |\n|---|---|---|\n`;
    Object.entries(rep.regime).forEach(([r,v]) => {
      const top = Object.entries(v.types).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([k,n])=>`${k} ${n}`).join(", ");
      m += `| ${r} | ${v.events} | ${top} |\n`;
    });
  }
  m += `\n## Next action\n\n`;
  const passed = rep.results.filter(r=>/PASS/.test(r.verdict)).map(r=>r.watcher);
  m += passed.length
    ? `**${passed.join(", ")}** met the gate and may graduate from shadow. Update the [[v4 Build Ledger]] and proceed to Step 2 (tune the rest).\n`
    : `No watcher met the gate. Tune parameters and re-run — remember: no change ships that regresses the benchmark (>2pp precision/recall, or a higher storm rate).\n`;
  m += `\n*Educational, not financial advice.*\n`;
  return m;
}

/* ---- main ---------------------------------------------------- */
function loadSeries(asset){
  if(!fs.existsSync(CACHE)) return [];
  return fs.readdirSync(CACHE).filter(f => f.startsWith(asset + "_") && f.endsWith(".json"))
    .map(f => JSON.parse(fs.readFileSync(path.join(CACHE, f), "utf8")))
    .filter(s => s.candles && s.candles.length)
    /* HARD GUARD: synthetic fixtures must never be mistaken for a real result.
       A benchmark contaminated by fabricated data is worse than no benchmark. */
    .filter(s => {
      if(/SYNTHETIC/i.test(s.source || "")){
        console.error(`  ! ignoring ${s.asset}_${s.tf} — cache is marked ${s.source}`);
        return false;
      }
      return true;
    });
}

function main(){
  const assets = process.argv.slice(2).filter(a=>!a.startsWith("-"));
  const scope  = assets.length ? assets : ["BTCUSDT"];

  const series = [], emitted = [];
  for(const asset of scope){
    const loaded = loadSeries(asset);
    if(!loaded.length){
      console.error(`\n  No cached klines for ${asset}.`);
      console.error(`  Run:  node replay/fetch-klines.js btc     (on the laptop — the sandbox cannot reach Binance)\n`);
      process.exit(2);
    }
    const levels = laddersFor(asset);
    for(const s of loaded){
      series.push({ asset, tf:s.tf, bars:s.candles.length,
                    from:new Date(s.candles[0].t).toISOString().slice(0,10),
                    to:new Date(s.candles[s.candles.length-1].t).toISOString().slice(0,10) });
      emitted.push(...replayCore({ asset, tf:s.tf, candles:s.candles, levels }));
    }
  }

  /* TOUCH_COUNT is tier-1 bookkeeping, not a detection. Scoring it as a
     prediction would crush precision for a purely clerical reason. */
  const scoreable = emitted.filter(e => e.tier >= 2);
  const results = ["structure","level"].map(w =>
    scoreWatcher(w, scoreable.filter(e => e.watcher === w), { scopeAssets: scope }));
  const allLabels = EVENTS.filter(e => e.detectability === "hard");
  /* full FP list for clustering — r.falsePositives is capped at 10 for display */
  const matchedIds = new Set(results.flatMap(r => (r.matchedEmittedIds || [])));
  const allFps = scoreable.filter(e => !matchedIds.has(e.id));

  const rep = {
    generatedAt: Date.now(),
    benchmarkVersion: "1.0.0",
    gate: GATE,
    assets: scope,
    series,
    emittedTotal: emitted.length,
    scoreableTotal: scoreable.length,
    tier1Excluded: emitted.length - scoreable.length,
    ladder: Object.fromEntries(scope.map(a => {
      const L2 = laddersFor(a);
      return [a, { real:L2.filter(x=>!x.decoy).length, decoy:L2.filter(x=>x.decoy).length }];
    })),
    results,
    calibration: calibrationCurve(emitted, allLabels),
    confidenceHistogram: confidenceHistogram(emitted),
    fpClusters: fpClusters(allFps),
    regime: regimePerformance(emitted, scope[0])
  };

  fs.writeFileSync(OUT_J, JSON.stringify(rep, null, 1));
  fs.writeFileSync(OUT_M, markdown(rep));

  console.log(`\nREPLAY COMPLETE`);
  console.log(`  bars replayed : ${series.reduce((a,s)=>a+s.bars,0)}`);
  console.log(`  events emitted: ${emitted.length}`);
  results.forEach(r => console.log(`  ${r.watcher.padEnd(10)} ${/PASS/.test(r.verdict)?"✅ PASS":"⬜ HOLD"}  `
    + `precision ${r.metrics.precision==null?"—":(r.metrics.precision*100).toFixed(0)+"%"}  `
    + `recall ${r.metrics.recall==null?"—":(r.metrics.recall*100).toFixed(0)+"%"}  `
    + `(tp ${r.metrics.tp} / fp ${r.metrics.fp} / fn ${r.metrics.fn})`));
  console.log(`\n  report → ${OUT_M}`);
}

if(require.main === module) main();
module.exports = { replayCore, calibrationCurve, fpClusters, regimePerformance, laddersFor };
