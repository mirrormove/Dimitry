/* ============================================================
   ASCENT ENGINE TESTS      Vault Intelligence v4 · Self-Improvement
   The properties that matter: no ceiling, EQ compounds on improvement and
   dips on regression, barriers ratchet, goals self-set by preference.
   ============================================================ */
"use strict";
const { snapshot, ascend } = require("./ascent.js");

const T = [], ok = (n,c,x) => T.push((c?"PASS ":"FAIL ")+n+(c||!x?"":"   → "+x));

/* a compact axis set for deterministic tests */
const AX = [
  { id:"acc",  label:"accuracy",  dir:"up", bound:true,  preference:0.6 },
  { id:"rr",   label:"realisedR", dir:"up", bound:false, preference:0.4 }
];
const step = (hist, snap) => ascend(hist, snap, { axes:AX, now:1 });

/* ══════════ BASELINE (first snapshot) ══════════ */
{
  const r = step([], { acc:0.80, rr:1.5 });
  ok("first snapshot sets EQ to the 100 baseline", r.eq === 100, "eq="+r.eq);
  ok("first snapshot sets barriers to current", r.barriers.acc === 0.8 && r.barriers.rr === 1.5);
  ok("no improvement is computed with no history", r.perAxis.every(a=>a.improvement===null));
  ok("ceiling is explicitly null (no peak)", r.ceiling === null);
}

/* ══════════ EQ COMPOUNDS on improvement ══════════ */
{
  const h = [{ at:0, snapshot:{acc:0.80, rr:1.5}, barriers:{acc:0.80, rr:1.5}, eq:100 }];
  const r = step(h, { acc:0.85, rr:1.8 });
  ok("EQ rises when axes improve", r.eq > 100, "eq="+r.eq);
  ok("cycleGrowth is positive", r.cycleGrowth > 0);
  ok("bounded improvement = fraction of remaining gap closed", Math.abs(r.perAxis.find(a=>a.id==="acc").improvement - (0.05/0.20)) < 1e-6,
     "imp="+r.perAxis.find(a=>a.id==="acc").improvement);
  ok("a broken barrier is recorded", r.barriersBroken.some(b=>b.axis==="acc") && r.barriers.acc===0.85);
}

/* ══════════ EQ DIPS on regression, barrier HOLDS ══════════ */
{
  const h = [{ at:0, snapshot:{acc:0.85, rr:1.8}, barriers:{acc:0.85, rr:1.8}, eq:104 }];
  const r = step(h, { acc:0.82, rr:1.6 });
  ok("EQ falls when axes regress", r.eq < 104, "eq="+r.eq);
  ok("cycleGrowth is negative", r.cycleGrowth < 0);
  ok("the barrier does NOT fall with a regression (best is a ratchet)", r.barriers.acc === 0.85);
  ok("regression does not count as breaking a barrier", !r.barriersBroken.some(b=>b.axis==="acc"));
  ok("a regressing axis is flagged as stalling", /Stalling/.test(r.selfAwareness.join(" ")));
}

/* ══════════ NO CEILING — the goal is always short of the ideal ══════════ */
{
  const h = [{ at:0, snapshot:{acc:0.90, rr:5}, barriers:{acc:0.99, rr:9}, eq:120 }];
  const r = step(h, { acc:0.995, rr:10 });
  const g = r.goals.find(x=>x.id==="acc");
  ok("even at 0.995 a bounded goal exists and is < 1 (perpetual)", g.target < 1 && g.target > 0.995, "target="+g.target);
  ok("an unbounded axis always has a higher target", r.goals.find(x=>x.id==="rr").target > 10);
  ok("goals carry ceiling:null", r.goals.every(x=>x.ceiling===null));
}

/* ══════════ SELF-SET GOALS ranked by PREFERENCE × headroom ══════════ */
{
  // acc has high preference but little headroom; rr lower pref but treated as room
  const h = [{ at:0, snapshot:{acc:0.98, rr:1.0}, barriers:{acc:0.98, rr:1.0}, eq:100 }];
  const r = step(h, { acc:0.985, rr:1.1 });
  ok("goals are ordered by priority (desc)", r.goals[0].priority >= r.goals[1].priority);
  ok("a near-maxed high-preference axis yields low priority (little headroom)",
     r.goals.find(x=>x.id==="acc").priority < 0.6);   // 0.6 pref × ~0.015 headroom
}

/* ══════════ UNMEASURED axis becomes a top self-set goal ══════════ */
{
  const AX2 = AX.concat([{ id:"timidity", label:"timidity guard", dir:"up", bound:true, preference:0.9 }]);
  const r = ascend([], { acc:0.8, rr:1.5, timidity:null }, { axes:AX2, now:1 });
  const g = r.goals.find(x=>x.id==="timidity");
  ok("an unmeasured, high-preference axis is a top goal", r.goals[0].id==="timidity", "top="+r.goals[0].id);
  ok("its status says establish the baseline", /baseline|UNMEASURED/i.test(g.status));
  ok("self-awareness names what it cannot yet measure", /not yet measurable/i.test(r.selfAwareness.join(" ")));
}

/* ══════════ REAL snapshot shape (honest nulls) ══════════ */
{
  const br = { portfolio:{ winRate:0.821, avgRfilled:1.48 } };
  const leaks = { impulsivity:{impulsiveEntries:6, opportunities:43},
                  timidity:{skippedEarnedSetups:0, winnersCutEarly:0, earnedOpportunities:0} };
  const s = snapshot(br, leaks);
  ok("accuracy comes from the portfolio win-rate", s.accuracy === 0.821);
  ok("setupQuality comes from realised R", s.setupQuality === 1.48);
  ok("timidity is NULL until it has a denominator (honest, not zero-from-thin-air)", s.timidityGuard === null);
  ok("impulsivity guard = 1 − leak rate when data exists", Math.abs(s.impulsivityGuard - (1-6/43)) < 1e-9);
}

/* ══════════ EFFICIENCY GRADUATION — improvement → consistency ══════════ */
{
  const below = { modelAccuracy:0.70, accuracy:0.70, precision:0.60, setupQuality:1.0 };
  const r = ascend([], below, { now:1, profitability:{expectancyR:0.8} });
  ok("below the efficiency threshold → IMPROVEMENT mode", r.mode==="improvement");
  ok("in improvement, EQ compounds on quality", r.eqBasis==="quality-improvement");
  ok("efficiency is computed and reported (<0.90)", r.efficiency!=null && r.efficiency < 0.90);
  ok("improvement names the TARGET as efficiency, not infinite metrics",
     r.goals[0].id==="reachEfficiency");

  const eff = { modelAccuracy:0.95, accuracy:0.93, precision:0.92, setupQuality:2.2 };
  const g = ascend([], eff, { now:1, profitability:{expectancyR:0.9} });
  ok("at/above the threshold → CONSISTENCY mode (stop tinkering)", g.mode==="consistency" && g.efficiency>=0.90);
  ok("in consistency, EQ compounds on PROFITABILITY, not metrics", g.eqBasis==="profitability-consistency");
  ok("consistency goals put HOLD + COMPOUND on top", g.goals[0].id==="compoundProfit" && g.goals[1].id==="holdEfficiency");
  ok("quality goals are marked do-not-over-tinker", g.goals.some(x=>/over-tinker/.test(x.status||"")));
  ok("priority order stated: profitability › self-improvement", g.selfAwareness.some(s=>/profitability . self-improvement/i.test(s)));
}

/* ══════════ CONSISTENCY EQ tracks profit; holding still ticks; growth compounds ══════════ */
{
  const eff = { modelAccuracy:0.95, accuracy:0.93, precision:0.92, setupQuality:2.2 };
  const hist = [{ at:0, snapshot:eff, barriers:{}, eq:120, mode:"consistency", efficiency:0.95,
                  consistencyStreak:3, profitability:{expectancyR:0.9} }];
  const flat = ascend(hist, eff, { now:1, profitability:{expectancyR:0.9} });
  ok("holding the efficient lane still ticks EQ up (consistency compounds)", flat.eq > 120);
  ok("the consistency streak extends", flat.consistencyStreak===4);
  const grew = ascend(hist, eff, { now:1, profitability:{expectancyR:1.1} });
  ok("rising profitability compounds MORE than flat", grew.eq > flat.eq);
}

/* ══════════ FALLING OUT of the lane is a flagged regression ══════════ */
{
  const drop = { modelAccuracy:0.70, accuracy:0.70, precision:0.60, setupQuality:1.0 };
  const hist = [{ at:0, snapshot:drop, barriers:{}, eq:130, mode:"consistency", efficiency:0.95, consistencyStreak:5, profitability:{expectancyR:0.9} }];
  const r = ascend(hist, drop, { now:1, profitability:{expectancyR:0.9} });
  ok("dropping below the floor reverts to IMPROVEMENT", r.mode==="improvement");
  ok("the streak resets to 0", r.consistencyStreak===0);
  ok("it is flagged as falling out of the lane (regression)", r.selfAwareness.some(s=>/FELL OUT/.test(s)));
}

console.log(T.join("\n"));
const f = T.filter(x=>x.startsWith("FAIL"));
console.log(f.length ? `\n*** ${f.length} FAIL / ${T.length} ***` : `\nALL ${T.length} PASS`);
process.exit(f.length?1:0);
