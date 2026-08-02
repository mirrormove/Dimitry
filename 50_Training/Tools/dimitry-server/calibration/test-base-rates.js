/* ============================================================
   BASE-RATE CALIBRATION TESTS   Vault Intelligence v4 · Step 8
   ============================================================ */
"use strict";
const { computeBaseRates, renderTable } = require("./base-rates.js");

const T = [], ok = (n,c,x) => T.push((c?"PASS ":"FAIL ")+n+(c||!x?"":"   → "+x));
const near = (a,b,e) => Math.abs(a-b) <= (e||0.005);

/* a small synthetic record whose per-category counts reconcile to the portfolio */
const SC = {
  source:"test", window:"t", n:20,
  portfolio:{ n:20, fired:14, wins:11, avgRfilled:1.5, totalR:16 },
  categories:[
    { id:"BIG",  name:"big sample, strong",  n:12, fired:12, wins:9, avgR:1.8 },
    { id:"TINY", name:"tiny sample, perfect",n:2,  fired:2,  wins:2, avgR:3.0 },
    { id:"COLD", name:"never fills",          n:6,  fired:0,  wins:0, avgR:0.0 }
  ]
};
/* Σn 20 ✓ · Σfired 14 ✓ · Σwins 11 ✓ */

const br = computeBaseRates(SC, null, { now: 1 });
const byId = Object.fromEntries(br.categories.map(c=>[c.id,c]));

/* ══════════ SHRINKAGE — the core claim ══════════ */
{
  const pWin0 = 11/14;                              // portfolio win prior ≈ 0.786
  const tiny = byId.TINY;
  ok("a tiny-sample perfect record is pulled BELOW its raw 100%", tiny.winRate < 1 && tiny.rawWin === 1);
  ok("tiny winRate lands between the prior and its raw rate", tiny.winRate > pWin0 && tiny.winRate < 1,
     `winRate=${tiny.winRate} prior=${pWin0.toFixed(3)}`);
  ok("tiny sample is flagged insufficient (n<5)", tiny.confidence === "insufficient");

  const big = byId.BIG;
  ok("a big sample barely moves from its raw rate", Math.abs(big.winRate - big.rawWin) < 0.06,
     `winRate=${big.winRate} raw=${big.rawWin}`);
  ok("big sample is flagged measured (n>=10)", big.confidence === "measured");
}

/* ══════════ ZERO-FILL fallback ══════════ */
{
  const cold = byId.COLD;
  ok("a category that has WON nothing does not report win 0 from thin air",
     cold.winRate > 0.5, `winRate=${cold.winRate}`);   // sits on the prior, not 0
  ok("zero-win category is explicitly noted as prior-only", /prior/.test(cold.note||""));
  ok("cold fill odds are shrunk down toward the low raw trigger", cold.fillOdds < br.portfolio.triggerRate,
     `fill=${cold.fillOdds} port=${br.portfolio.triggerRate}`);
}

/* ══════════ pSuccess = fill × win ══════════ */
{
  const big = byId.BIG;
  ok("baseProb equals fillOdds × winRate", near(big.baseProb, +(big.fillOdds*big.winRate).toFixed(2)),
     `${big.baseProb} vs ${(big.fillOdds*big.winRate).toFixed(2)}`);
  ok("baseProb is a probability in [0,1]", big.baseProb>0 && big.baseProb<=1);
}

/* ══════════ EXPECTANCY signs ══════════ */
{
  ok("a positive-edge category shows positive E[R]/filled", byId.BIG.expPerFilled > 0);
  ok("a 0R-avg, 0-win category shows non-positive E[R]/filled", byId.COLD.expPerFilled <= 0);
  ok("E[R]/signal is scaled below E[R]/filled by the fill rate",
     Math.abs(byId.BIG.expPerSignal) < Math.abs(byId.BIG.expPerFilled));
}

/* ══════════ DETECTOR merge ══════════ */
{
  const adj = { typeVerdicts:[
    { type:"BOS_CONFIRMED", nUnlabelled:178, netEdge:0.368, verdict:"LIKELY REAL" },
    { type:"CHOCH_CONFIRMED", nUnlabelled:64, netEdge:-0.076, verdict:"NOISE" }
  ]};
  const b2 = computeBaseRates(SC, adj, { now:1 });
  ok("detectors carried through from adjudication", b2.detectors.length === 2);
  ok("edge above the bar is marked usable", b2.detectors.find(d=>d.type==="BOS_CONFIRMED").usable === true);
  ok("negative edge is NOT usable", b2.detectors.find(d=>d.type==="CHOCH_CONFIRMED").usable === false);
  ok("detectors sorted by net edge (best first)", b2.detectors[0].type === "BOS_CONFIRMED");
}

/* ══════════ RECONCILIATION guard ══════════ */
{
  let threw = false;
  try { require("./scorecard-data.js"); } catch(e){ threw = true; }
  ok("the REAL scorecard-data reconciles (loads without throwing)", !threw);
}

/* ══════════ RENDER ══════════ */
{
  const md = renderTable(br);
  ok("render produces a fenced, machine-owned block", /BEGIN CALIBRATED[\s\S]*END CALIBRATED/.test(md));
  ok("render marks small samples", /☠|⚠/.test(md));
}

/* ══════════ updateNote IDEMPOTENCY (regression: the double-block bug) ══════════ */
{
  const fs = require("fs");
  const { updateNote } = require("./base-rates.js");
  const tmp = "/tmp/base-rates-note-"+Math.random().toString(36).slice(2)+".md";
  fs.writeFileSync(tmp, "# Base Rates\n\n## Measured (n=43)\n\nsome prose\n");
  updateNote(tmp, renderTable(br));
  updateNote(tmp, renderTable(computeBaseRates(SC, null, { now: 2 })));
  updateNote(tmp, renderTable(br));
  const body = fs.readFileSync(tmp, "utf8");
  const n = (body.match(/BEGIN CALIBRATED/g)||[]).length;
  ok("three writes leave exactly ONE calibrated block", n === 1, "blocks="+n);
  ok("the manual prose above the block survives", /some prose/.test(body));
  fs.unlinkSync(tmp);
}

console.log(T.join("\n"));
const f = T.filter(x=>x.startsWith("FAIL"));
console.log(f.length ? `\n*** ${f.length} FAIL / ${T.length} ***` : `\nALL ${T.length} PASS`);
process.exit(f.length?1:0);
