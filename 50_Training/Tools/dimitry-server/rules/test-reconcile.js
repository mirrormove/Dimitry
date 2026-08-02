/* ============================================================
   RECONCILIATION TESTS   Vault Intelligence v4 · Step 3
   ============================================================ */
"use strict";
const { reconcile, setupsFromBeliefs, parseSetupBelief, classifyEntry } = require("./reconcile.js");
const T=[], ok=(n,c,x)=>T.push((c?"PASS ":"FAIL ")+n+(c||!x?"":"   → "+x));

/* a BTC OB short: fade the 65,354–66,000 zone, stop 66,150, T1 64,780 */
const setup = parseSetupBelief({ key:"BTCUSDT.primarySetup", class:"opportunity", asset:"BTCUSDT",
  value:"FADE the OB 65,354–66,000 · Stop 66,150 · T1 64,780 / T2 63,666 · 1%" });
const setups=[setup];

/* ══════════ PARSING ══════════ */
{
  ok("parses direction", setup.dir==="short");
  ok("parses the zone", setup.zone[0]===65354 && setup.zone[1]===66000);
  ok("parses the stop", setup.stop===66150);
  ok("best entry is the zone edge nearest the stop (short → top)", setup.bestEntry===66000);
  ok("computes T1 R:R from best entry & stop", setup.t1R>7);
  ok("setupsFromBeliefs filters to directional zoned setups",
     setupsFromBeliefs([{class:"opportunity",asset:"BTCUSDT",value:"FADE 65,354–66,000 · Stop 66,150"},{class:"structure",value:"x"}]).length===1);
}

/* ══════════ ENTRY LOCATION ══════════ */
{
  ok("entry inside the zone = on-location", classifyEntry({entry:65900,dir:"short"}, setup)==="on");
  ok("short entered BELOW the zone (chased down) = late", classifyEntry({entry:64500,dir:"short"}, setup)==="late");
  ok("short entered ABOVE the zone (front-run) = early", classifyEntry({entry:66600,dir:"short"}, setup)==="early");
}

/* ══════════ FOLLOWED — on-location, held ══════════ */
{
  const r=reconcile([{asset:"BTCUSDT",dir:"short",entry:65950,r:2.1,mfeR:2.1}], setups, []);
  const rec=r.records[0];
  ok("a fill in the zone is FOLLOWED", rec.class==="followed" && rec.setupKey==="BTCUSDT.primarySetup");
  ok("on-location entry carries no entry leak", rec.location==="on" && !rec.leaks.includes("late-entry"));
  ok("held winner is clean discipline", rec.management==="held" && rec.discipline>=9);
}

/* ══════════ FOLLOWED — late entry (chased) ══════════ */
{
  const r=reconcile([{asset:"BTCUSDT",dir:"short",entry:64200,r:0.4}], setups, []);
  ok("chasing below the zone tags late-entry", r.records[0].leaks.includes("late-entry"));
  ok("late entry costs discipline", r.records[0].discipline<=7);
  ok("late entry feeds the impulsivity leak", r.leaks.impulsivity.impulsiveEntries===1);
}

/* ══════════ CUT EARLY (timidity in management) ══════════ */
{
  const r=reconcile([{asset:"BTCUSDT",dir:"short",entry:65950,r:0.6,mfeR:2.4}], setups, []);
  ok("banking +0.6R when +2.4R was available = cut-early", r.records[0].management==="cut-early");
  ok("cut-early feeds winnersCutEarly (timidity)", r.leaks.timidity.winnersCutEarly===1);
}

/* ══════════ OFF-PLAN (impulsive) ══════════ */
{
  const r=reconcile([{asset:"BTCUSDT",dir:"long",entry:70000,r:-1}], setups, []);   // no matching long setup
  ok("a fill with no matching setup is OFF-PLAN", r.records[0].class==="off-plan");
  ok("off-plan is tagged and low discipline", r.records[0].leaks.includes("off-plan") && r.records[0].discipline<=3);
  ok("off-plan feeds impulsivity", r.leaks.impulsivity.impulsiveEntries===1);
}

/* ══════════ SKIPPED-EARNED (timidity) ══════════ */
{
  const intents=[{setupKey:"BTCUSDT.primarySetup",asset:"BTCUSDT",dir:"short",intent:"skipped"}];
  const r=reconcile([], setups, intents);
  ok("an explicitly-skipped armed setup = skipped-earned", r.skipped.length===1);
  ok("skipped-earned feeds the timidity leak", r.leaks.timidity.skippedEarnedSetups===1);
  ok("no fabricated leaks from an empty book", reconcile([],setups,[]).leaks.timidity.skippedEarnedSetups===0);
}

/* ══════════ HONEST DENOMINATORS ══════════ */
{
  const r=reconcile([{asset:"BTCUSDT",dir:"short",entry:65950,r:2}], setups,
                    [{setupKey:"BTCUSDT.primarySetup",intent:"skipped",asset:"BTCUSDT"}]);
  ok("denominator = decisions engaged (1 fill + 1 skip = 2)", r.leaks.timidity.earnedOpportunities===2);
  ok("summary is human-readable", /on-plan/.test(r.summary));
}

console.log(T.join("\n"));
const f=T.filter(x=>x.startsWith("FAIL"));
console.log(f.length ? `\n*** ${f.length} FAIL / ${T.length} ***` : `\nALL ${T.length} PASS`);
process.exit(f.length?1:0);
