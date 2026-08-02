/* ============================================================
   FALSE-POSITIVE ADJUDICATION      Vault Intelligence v4 · Step 2b
   Zero dependencies.

   THE QUESTION: the detectors emit ~470 events the benchmark does not
   label. Is that OVER-FIRING (the detector is wrong) or UNDER-LABELLING
   (the benchmark is incomplete)? Rebuilding the detector to match an
   incomplete benchmark would be exactly the wrong move.

   THE METHOD: do not ask the detector, and do not ask its author. Ask the
   MARKET. For every unlabelled event, measure what price did NEXT — data
   the detector never saw at emission time — and compare it against:

     · the labelled events   (what a "real" event looks like)
     · random bars           (what nothing looks like)

   If unlabelled events behave like random bars, they are noise and the
   detector is over-firing. If they behave like labelled events, the
   benchmark is under-labelled and the detector is closer to right than
   its precision score suggests.

   Run:  node calibration/adjudicate.js
   ============================================================ */
"use strict";
const fs   = require("fs");
const path = require("path");
const { EVENTS } = require("./labelled-events.js");
const { replayCore, laddersFor } = require("../replay/replay.js");
const { atr } = require("../watchers/lib.js");

const CACHE = path.resolve(__dirname, "..", "..", "klines");
const OUT   = path.resolve(__dirname, "..", "..", "adjudication.json");
const OUT_M = path.resolve(__dirname, "..", "..", "adjudication.md");

const HORIZONS = [5, 10, 20];          // bars forward
const SCOREABLE_TF = ["1D","4H","1H"];  // where the benchmark has real coverage

/** Direction the event implies, or null if it makes no directional claim. */
function impliedDir(e){
  const d = e.evidence && e.evidence.direction;
  if(d === "up") return 1;
  if(d === "down") return -1;
  switch(e.type){
    case "SWEEP_RECLAIM": return e.evidence && e.evidence.reclaim ? 1 : null;
    case "LEVEL_REJECT":  return e.evidence && e.evidence.close < e.level ? -1 : 1;
    case "OB_MITIGATED":  return e.evidence && e.evidence.dir === "bull" ? 1 : -1;
    case "FVG_FILLED":    return e.evidence && e.evidence.dir === "bull" ? 1 : -1;
    default: return null;
  }
}

/** Max favourable excursion in the implied direction, in ATR units. */
function mfe(candles, i, dir, horizon, a){
  if(!a || i + horizon >= candles.length) return null;
  const entry = candles[i].c;
  let best = 0;
  for(let k = i + 1; k <= i + horizon; k++){
    const move = dir > 0 ? candles[k].h - entry : entry - candles[k].l;
    if(move > best) best = move;
  }
  return best / a;
}
/** Max ADVERSE excursion — how much it went against the claim first. */
function mae(candles, i, dir, horizon, a){
  if(!a || i + horizon >= candles.length) return null;
  const entry = candles[i].c;
  let worst = 0;
  for(let k = i + 1; k <= i + horizon; k++){
    const move = dir > 0 ? entry - candles[k].l : candles[k].h - entry;
    if(move > worst) worst = move;
  }
  return worst / a;
}

const stats = arr => {
  const v = arr.filter(x => x != null).sort((a,b)=>a-b);
  if(!v.length) return null;
  return { n:v.length,
           median:+v[Math.floor(v.length/2)].toFixed(3),
           mean:+(v.reduce((a,b)=>a+b,0)/v.length).toFixed(3),
           p75:+v[Math.floor(v.length*0.75)].toFixed(3) };
};

function main(){
  if(!fs.existsSync(CACHE)){ console.error("no kline cache — run RUN REPLAY.bat first"); process.exit(2); }

  const series = fs.readdirSync(CACHE).filter(f=>f.startsWith("BTCUSDT_"))
    .map(f => JSON.parse(fs.readFileSync(path.join(CACHE,f),"utf8")))
    .filter(s => SCOREABLE_TF.includes(s.tf));

  const levels = laddersFor("BTCUSDT");
  const labels = EVENTS.filter(e => e.asset === "BTCUSDT" && e.detectability === "hard");

  const rows = { labelled:[], unlabelled:[], random:[] };
  const byType = {};

  for(const s of series){
    const idxOf = t => s.candles.findIndex(c => c.t <= t && t < c.t + (s.candles[1].t - s.candles[0].t));
    const emitted = replayCore({ asset:"BTCUSDT", tf:s.tf, candles:s.candles, levels })
                      .filter(e => e.tier >= 2);

    for(const e of emitted){
      const dir = impliedDir(e);
      if(dir == null) continue;
      const i = s.candles.findIndex(c => c.t === e.t);
      if(i < 20) continue;
      const a = atr(s.candles.slice(Math.max(0,i-20), i+1), 14);
      const rec = { tf:s.tf, type:e.type, t:e.t, level:e.level, dir, conf:e.confidence,
                    mfe:{}, mae:{} };
      for(const h of HORIZONS){ rec.mfe[h] = mfe(s.candles,i,dir,h,a); rec.mae[h] = mae(s.candles,i,dir,h,a); }

      /* is this event one the benchmark labelled? */
      const isLabelled = labels.some(l => l.tf === s.tf &&
        l.level != null && e.level != null && Math.abs(e.level-l.level)/l.level*100 <= 0.15 &&
        Math.abs(e.t - l.t) <= 864e5);
      (isLabelled ? rows.labelled : rows.unlabelled).push(rec);

      const k = e.type;
      (byType[k] = byType[k] || { labelled:[], unlabelled:[] })[isLabelled?"labelled":"unlabelled"].push(rec);
    }

    /* NULL MODEL — random bars, random direction, same measurement */
    for(let n = 0; n < 400; n++){
      const i = 20 + Math.floor(Math.random() * (s.candles.length - 40));
      const dir = Math.random() < 0.5 ? 1 : -1;
      const a = atr(s.candles.slice(Math.max(0,i-20), i+1), 14);
      const rec = { tf:s.tf, type:"RANDOM", dir, mfe:{}, mae:{} };
      for(const h of HORIZONS){ rec.mfe[h] = mfe(s.candles,i,dir,h,a); rec.mae[h] = mae(s.candles,i,dir,h,a); }
      rows.random.push(rec);
    }
  }

  const summary = {};
  for(const g of ["labelled","unlabelled","random"]){
    summary[g] = {};
    for(const h of HORIZONS){
      summary[g][h] = { mfe: stats(rows[g].map(r=>r.mfe[h])), mae: stats(rows[g].map(r=>r.mae[h])) };
    }
    summary[g].n = rows[g].length;
  }

  /* per-type: does this event type beat the null? */
  const typeVerdicts = [];
  for(const [type, g] of Object.entries(byType)){
    const un = stats(g.unlabelled.map(r=>r.mfe[10]));
    const lab= stats(g.labelled.map(r=>r.mfe[10]));
    const rnd= summary.random[10].mfe;
    if(!un) continue;
    const edge = rnd ? +(un.median - rnd.median).toFixed(3) : null;
    /* CONTROL: high MFE with equally high MAE is just volatility, not direction.
       The discriminator is NET = MFE - MAE, compared against the same net for
       random bars. Without this, a detector that fires in volatile conditions
       would look skilful while predicting nothing. */
    const unMae = stats(g.unlabelled.map(r=>r.mae[10]));
    const rndMae= summary.random[10].mae;
    const netUn = unMae ? +(un.median - unMae.median).toFixed(3) : null;
    const netRnd= rndMae ? +(rnd.median - rndMae.median).toFixed(3) : null;
    const netEdge = (netUn!=null && netRnd!=null) ? +(netUn - netRnd).toFixed(3) : null;
    typeVerdicts.push({ type, nUnlabelled:un.n, nLabelled:lab?lab.n:0,
      medianMfeUnlabelled:un.median, medianMfeLabelled:lab?lab.median:null,
      medianMfeRandom:rnd?rnd.median:null, edgeVsRandom:edge,
      medianMaeUnlabelled: unMae?unMae.median:null, netUnlabelled:netUn, netRandom:netRnd, netEdge,
      verdict: netEdge == null ? "no baseline"
             : netEdge > 0.20 ? "LIKELY REAL — benchmark may be under-labelled"
             : netEdge < -0.05 ? "NOISE — worse than random"
             : "INDISTINGUISHABLE FROM RANDOM — over-firing" });
  }
  typeVerdicts.sort((a,b)=>(b.netEdge??-9)-(a.netEdge??-9));

  const rep = { generatedAt:Date.now(), horizons:HORIZONS, summary, typeVerdicts };
  fs.writeFileSync(OUT, JSON.stringify(rep, null, 1));
  fs.writeFileSync(OUT_M, markdown(rep));

  console.log("\nADJUDICATION — is it over-firing, or is the benchmark under-labelled?\n");
  console.log(`  labelled events   n=${summary.labelled.n}   median MFE(10 bars) = ${summary.labelled[10].mfe?summary.labelled[10].mfe.median:"—"} ATR`);
  console.log(`  UNlabelled events n=${summary.unlabelled.n}  median MFE(10 bars) = ${summary.unlabelled[10].mfe?summary.unlabelled[10].mfe.median:"—"} ATR`);
  console.log(`  random bars       n=${summary.random.n}  median MFE(10 bars) = ${summary.random[10].mfe.median} ATR\n`);
  console.log("  per event type (10-bar horizon):");
  console.log("   type                 n    MFE    MAE    NET   vs rnd   verdict");
  for(const t of typeVerdicts)
    console.log(`   ${t.type.padEnd(18)}${String(t.nUnlabelled).padStart(5)} ${String(t.medianMfeUnlabelled).padStart(6)} ${String(t.medianMaeUnlabelled).padStart(6)} ${String(t.netUnlabelled).padStart(6)} ${String(t.netEdge).padStart(7)}   ${t.verdict}`);
  console.log(`\n  report → ${OUT_M}`);
}

function markdown(rep){
  let m = `# False-Positive Adjudication\n\n> Generated ${new Date(rep.generatedAt).toISOString().slice(0,16).replace("T"," ")}Z\n\n`;
  m += `**Question:** the detectors emit ~470 events the benchmark does not label. Over-firing, or under-labelling?\n\n`;
  m += `**Method:** ask the market, not the detector or its author. For each event, measure the max favourable excursion `
     + `(MFE) in the direction the event implies, over the next 5/10/20 bars — data the detector never saw. `
     + `Compare unlabelled events against labelled ones (what a real event looks like) and against random bars (what nothing looks like).\n\n`;
  m += `## Headline\n\n| Group | n | Median MFE (10 bars, ATR) | Median MAE |\n|---|---|---|---|\n`;
  for(const g of ["labelled","unlabelled","random"]){
    const s = rep.summary[g];
    m += `| ${g} | ${s.n} | ${s[10].mfe?s[10].mfe.median:"—"} | ${s[10].mae?s[10].mae.median:"—"} |\n`;
  }
  m += `\n## Per event type (10-bar horizon)\n\n| Type | n | MFE | MAE | NET (MFE−MAE) | NET vs random | Verdict |\n|---|---|---|---|---|---|---|\n`;
  for(const t of rep.typeVerdicts)
    m += `| ${t.type} | ${t.nUnlabelled} | ${t.medianMfeUnlabelled} | ${t.medianMaeUnlabelled} | ${t.netUnlabelled} | ${t.netEdge} | ${t.verdict} |\n`;
  m += `\n## How to read this\n\n`;
  m += `- **Edge > 0.15 ATR** — unlabelled events of this type behave like real ones. The benchmark is probably missing them; label a sample and re-run rather than suppressing the detector.\n`;
  m += `- **Edge ≈ 0** — indistinguishable from a random bar. The detector is over-firing and this type needs a significance filter.\n`;
  m += `- **Edge < 0** — worse than random. The type is actively misleading and should be suppressed or inverted.\n\n`;
  m += `*Educational, not financial advice.*\n`;
  return m;
}

if(require.main === module) main();
module.exports = { impliedDir, mfe, mae };
