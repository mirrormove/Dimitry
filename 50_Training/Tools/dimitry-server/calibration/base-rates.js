/* ============================================================
   BASE-RATE CALIBRATION       Vault Intelligence v4 · Step 8
   Zero dependencies.   Closes the loop: measured record → base rates → system.

   Layer 7 (learning) feeding Layer 1 (priors). Turns the scored record
   (calibration/scorecard-data.js) and the detector adjudication
   (adjudication.json) into ONE machine artifact — base-rates.json — that the
   watchers and dashboard read, replacing hand-set probabilities.

   THE ONE IDEA THAT MAKES THIS HONEST — SHRINKAGE.
   A raw win-rate on n=2 ("sweep-reversal 100%") is not a 100% edge; it is two
   coin-flips that landed the same way. Every category rate is pulled toward the
   PORTFOLIO PRIOR by a pseudocount K, so small samples inherit the book's
   average until they earn their own number:

       p_shrunk = (successes + K · prior) / (trials + K)

   K=4 means "trust a category's own rate only once it has clearly outvoted four
   prior-observations." Big samples (E n=9, F n=11) barely move; tiny ones
   (D n=2, RANGE n=1) sit near the prior with an explicit confidence flag.

   Run:  node calibration/base-rates.js         (writes base-rates.json + the note)
   ============================================================ */
"use strict";
const fs   = require("fs");
const path = require("path");

const K = 4;                                    // shrinkage pseudocount
const HERE   = __dirname;
const TOOLS  = path.resolve(HERE, "..", "..");                 // 50_Training/Tools
const OUT_JSON = path.resolve(TOOLS, "base-rates.json");
const ADJ_JSON = path.resolve(TOOLS, "adjudication.json");
const VAULT  = path.resolve(TOOLS, "..", "..");                // → Trading/
const NOTE   = path.resolve(VAULT, "20_Patterns", "Base Rates.md");
const EDGE_BAR = 0.20;                           // ATR net-edge a detector must clear to be "usable"
                                                 // (matches adjudicate.js's "LIKELY REAL" threshold, so
                                                 //  `usable` never contradicts the verdict string)

const r3 = x => x==null ? null : +x.toFixed(3);
const r2 = x => x==null ? null : +x.toFixed(2);

/** Pure calibration. No I/O — takes the record + (optional) adjudication, returns the artifact. */
function computeBaseRates(scorecard, adjudication, opts){
  opts = opts || {};
  const K_ = opts.K != null ? opts.K : K;
  const P = scorecard.portfolio;
  const pTrig0 = P.fired / P.n;                  // portfolio trigger prior
  const pWin0  = P.wins  / P.fired;              // portfolio win-given-fill prior

  const categories = scorecard.categories.map(c => {
    const rawTrigger = c.n ? c.fired / c.n : null;
    const rawWin     = c.fired ? c.wins / c.fired : null;

    // shrink both rates toward the portfolio prior
    const pTrigger = (c.fired + K_ * pTrig0) / (c.n + K_);
    // with zero fills there is no own-evidence for win-rate → sit on the prior, low confidence
    const winRate  = c.fired > 0 ? (c.wins + K_ * pWin0) / (c.fired + K_) : pWin0;

    const avgR = c.avgR != null ? c.avgR : null;
    // expectancy per FILLED signal, scoring a loss as −1R (the vault's as-written convention)
    const expPerFilled = avgR != null ? winRate * avgR - (1 - winRate) * 1 : null;
    // expectancy per SIGNAL, folding in the no-trigger rate (those score 0R)
    const expPerSignal = expPerFilled != null ? pTrigger * expPerFilled : null;
    // single coherent "works as written" probability: it fills AND it wins
    const pSuccess = winRate != null ? pTrigger * winRate : null;

    const confidence = c.n >= 10 ? "measured" : c.n >= 5 ? "directional" : "insufficient";

    return {
      id: c.id, name: c.name, n: c.n, fired: c.fired, wins: c.wins, avgR,
      rawTrigger: r3(rawTrigger), rawWin: r3(rawWin),
      fillOdds: r3(pTrigger),          // shrunk P(zone reached & filled as written)
      winRate:  r3(winRate),           // shrunk P(win | filled)
      baseProb: r2(pSuccess),          // shrunk P(works as written) — the number the system trusts
      expPerFilled: r2(expPerFilled),
      expPerSignal: r2(expPerSignal),
      confidence,
      note: c.fired === 0 ? "no fills yet — win-rate is the portfolio prior, not own evidence" : null
    };
  });

  // detector precision layer — the watcher/detector reliability, straight from adjudication
  let detectors = [];
  if(adjudication && Array.isArray(adjudication.typeVerdicts)){
    detectors = adjudication.typeVerdicts.map(t => ({
      type: t.type, n: t.nUnlabelled, netEdge: t.netEdge, verdict: t.verdict,
      usable: t.netEdge != null && t.netEdge >= EDGE_BAR
    })).sort((a,b) => (b.netEdge ?? -9) - (a.netEdge ?? -9));
  }

  return {
    generatedAt: opts.now || Date.now(),
    method: `bayesian shrinkage toward the portfolio prior (K=${K_}); loss=−1R; success=fill×win`,
    source: scorecard.source, window: scorecard.window, n: scorecard.n,
    portfolio: {
      n: P.n, fired: P.fired, wins: P.wins,
      triggerRate: r3(pTrig0), winRate: r3(pWin0), avgRfilled: P.avgRfilled, totalR: P.totalR
    },
    edgeBar: EDGE_BAR,
    categories, detectors,
    provenance: {
      scorecard: scorecard.source,
      adjudication: adjudication ? "adjudication.json" : null,
      shrinkageK: K_
    }
  };
}

/** Regenerate the "Measured" table block of the Base Rates note from the artifact. */
function renderTable(br){
  const head = "| Setup type | n | Fill odds | Win rate | Works p | E[R]/filled | Confidence |\n"
             + "|---|---|---|---|---|---|---|";
  const rows = br.categories.map(c => {
    const flag = c.confidence === "measured" ? "" : c.confidence === "directional" ? " ⚠" : " ☠";
    const wp = c.baseProb != null ? c.baseProb.toFixed(2) : "—";
    return `| **${c.name}** | ${c.n} | ${c.fillOdds.toFixed(2)} | ${c.winRate.toFixed(2)} | ${wp} | ${c.expPerFilled!=null?(c.expPerFilled>=0?"+":"")+c.expPerFilled.toFixed(2)+"R":"—"} | ${c.confidence}${flag} |`;
  });
  const P = br.portfolio;
  const det = br.detectors.length
    ? "\n\n### Detector precision (from adjudication.json)\n\n"
      + "| Detector | n | Net edge (ATR) | Usable? | Verdict |\n|---|---|---|---|---|\n"
      + br.detectors.map(d => `| ${d.type} | ${d.n} | ${d.netEdge} | ${d.usable?"✅":"—"} | ${d.verdict} |`).join("\n")
    : "";
  return `<!-- BEGIN CALIBRATED (generated by calibration/base-rates.js — do not hand-edit) -->\n`
       + `> **Machine-calibrated ${new Date(br.generatedAt).toISOString().slice(0,10)}** — ${br.method}. `
       + `Portfolio: trigger ${(P.triggerRate*100).toFixed(0)}% (${P.fired}/${P.n}) · win-of-filled ${(P.winRate*100).toFixed(0)}% (${P.wins}/${P.fired}) · +${P.avgRfilled}R/filled · +${P.totalR}R total.\n\n`
       + head + "\n" + rows.join("\n") + "\n"
       + "\n*Fill odds & win rate are shrunk toward the portfolio prior by n; ☠ = insufficient (n<5), ⚠ = directional (n<10).*"
       + det + "\n<!-- END CALIBRATED -->";
}

/** Splice the generated block into Base Rates.md between its markers (or append). */
function updateNote(notePath, block){
  let md = "";
  try { md = fs.readFileSync(notePath, "utf8"); } catch(e){ /* note absent — skip */ return false; }
  /* Strip ANY previously generated block(s) first — the BEGIN marker carries a trailing
     "(generated…)" note, so match up to END loosely. This is idempotent and self-repairs
     duplicates from an earlier mismatch. */
  md = md.replace(/\n*<!-- BEGIN CALIBRATED[\s\S]*?END CALIBRATED -->\n*/g, "\n");
  md = /## Measured[^\n]*\n/.test(md)
     ? md.replace(/(## Measured[^\n]*\n)/, `$1\n${block}\n`)
     : md + `\n\n${block}\n`;
  fs.writeFileSync(notePath, md);
  return true;
}

function main(){
  const scorecard = require("./scorecard-data.js");
  let adj = null;
  try { adj = JSON.parse(fs.readFileSync(ADJ_JSON, "utf8")); } catch(e){ /* optional */ }
  const br = computeBaseRates(scorecard, adj);
  fs.writeFileSync(OUT_JSON, JSON.stringify(br, null, 2));
  const noted = updateNote(NOTE, renderTable(br));
  console.log(`base-rates.json written · ${br.categories.length} categories · ${br.detectors.length} detectors`);
  console.log(`Base Rates note ${noted ? "updated" : "NOT found (skipped)"}`);
  for(const c of br.categories)
    console.log(`  ${c.id.padEnd(6)} n=${String(c.n).padStart(2)} fill ${c.fillOdds} · win ${c.winRate} · works ${c.baseProb} · E/filled ${c.expPerFilled} · ${c.confidence}`);
}

if(require.main === module) main();
module.exports = { computeBaseRates, renderTable, updateNote, K };
