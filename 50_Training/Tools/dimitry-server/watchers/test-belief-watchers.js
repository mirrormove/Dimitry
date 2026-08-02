/* ============================================================
   BELIEF-WATCHER TESTS       Vault Intelligence v4 · Step 4
   Contradiction + Opportunity (Move Capture rev 2). No price data.
   ============================================================ */
"use strict";
const C = require("./contradiction.js");
const O = require("./opportunity.js");
const { BeliefStore } = require("../belief-store.js");

const T = [], ok = (n,c,x) => T.push((c?"PASS ":"FAIL ")+n+(c||!x?"":"   → "+x));
const D = s => Date.parse(s);
const NOW = D("2026-07-28T12:00:00Z");
const hoursAgo = h => NOW - h*3.6e6;

function freshStore(){
  const s = new BeliefStore("/tmp/bw-test-"+Math.random().toString(36).slice(2)+".json");
  s.set({ key:"doctrine.account.personal", claim:"Personal account status",
          value:"NO TRADE — grid unresolved", confidence:1, class:"doctrine",
          setBy:"operator", setAt:hoursAgo(200) });
  return s;
}

/* ══════════ DIRECTION EXTRACTION (contradiction) ══════════ */
{
  const d = C.statedDirection;
  ok("reads a plain LONG", d({value:"GOLDEN-ZONE LONG: buy 4,081–4,090"})==="long");
  ok("reads a plain SHORT", d({value:"SHORT the golden pocket 1.33462"})==="short");
  ok("a probability split picks the larger side", d({value:"slight bull 52 / 48"})==="long");
  ok("an even split claims nothing", d({value:"50 bull / 50 bear"})===null);
  ok("range language claims nothing", d({value:"range, no directional edge"})===null);
  ok("a 50/50 inflection claims nothing even if it says 'bull structure'",
     d({value:"50/50 inflection — bull structure, exhausted momentum"})===null);
  ok("a still-directional split is unaffected", d({value:"slight bull 52 / 48"})==="long");
}

/* ══════════ CONTRADICTION ══════════ */
{
  const s = freshStore();
  s.set({ key:"BTCUSDT.bias", claim:"BTC bias", value:"range 49 bull / 51 bear",
          confidence:0.51, class:"structure", asset:"BTCUSDT", setAt:hoursAgo(20),
          invalidator:"1D close > 67,292" });
  s.set({ key:"BTCUSDT.primarySetup", claim:"BTC primary setup",
          value:"SHORT the OB 65,354–66,000 · T1 2.7:1", confidence:0.6,
          class:"opportunity", asset:"BTCUSDT", setAt:hoursAgo(20),
          invalidator:"1D close > 67,292" });
  const r = C.run(s, { now: NOW });
  ok("clean book raises no orphan", !r.events.some(e=>e.type==="BELIEF_ORPHANED"));
  ok("aligned setup+bias raises no conflict", !r.events.some(e=>e.type==="BELIEF_CONFLICT"));
}
{
  const s = freshStore();
  const bias = s.set({ key:"XAUUSD.bias", claim:"Gold bias", value:"slight bull 52 / 48",
          confidence:0.52, class:"structure", asset:"XAUUSD", setAt:hoursAgo(30) });
  bias.status = "invalidated";
  s.set({ key:"XAUUSD.primarySetup", claim:"Gold golden-zone long",
          value:"LONG 4,081–4,090 · T2 2.1:1", confidence:0.55,
          class:"opportunity", asset:"XAUUSD", setAt:hoursAgo(30), invalidator:"1D close < 4,081" });
  const r = C.run(s, { now: NOW });
  const orph = r.events.find(e=>e.type==="BELIEF_ORPHANED");
  ok("ORPHANED when the parent bias is dead", !!orph);
  ok("orphan is T4", !!orph && orph.tier===4);
}
{
  const s = freshStore();
  s.set({ key:"GBPUSD.bias", claim:"Cable bias", value:"bear 58 / 42",
          confidence:0.58, class:"structure", asset:"GBPUSD", setAt:hoursAgo(10),
          invalidator:"4H close > 1.33934" });
  s.set({ key:"GBPUSD.primarySetup", claim:"Cable setup", value:"LONG the shelf 1.3360 · 1.8:1",
          confidence:0.6, class:"opportunity", asset:"GBPUSD", setAt:hoursAgo(10),
          invalidator:"daily close < 1.3360" });
  const r = C.run(s, { now: NOW });
  const cf = r.events.find(e=>e.type==="BELIEF_CONFLICT");
  ok("CONFLICT when the setup opposes its bias", !!cf);
  ok("conflict posed as a question", !!cf && /counter-trend by design|unreconciled/i.test(cf.fact));
}
{
  /* a setup that DECLARES itself counter-trend is acknowledged by authorship — no flag (K44) */
  const s = freshStore();
  s.set({ key:"USDJPY.bias", claim:"Ninja bias", value:"Slight bull 55/45 — CHoCH false sweep confirmed",
          confidence:0.55, class:"structure", asset:"USDJPY", setAt:hoursAgo(4) });
  s.set({ key:"USDJPY.primarySetup", claim:"Ninja setup",
          value:"SHORT the bearish OB 163.823–163.866 on a 1H rejection — deliberate counter-trend, half size",
          confidence:0.6, class:"opportunity", asset:"USDJPY", setAt:hoursAgo(4),
          invalidator:"1H hold/reclaim > 163.866" });
  ok("a DECLARED counter-trend setup raises NO conflict (K44 root fix)",
     !C.run(s,{now:NOW}).events.some(e=>e.type==="BELIEF_CONFLICT"));
  /* but an UNDECLARED opposition is still surfaced */
  const s2 = freshStore();
  s2.set({ key:"USDJPY.bias", claim:"Ninja bias", value:"bull 60/40", confidence:0.6,
           class:"structure", asset:"USDJPY", setAt:hoursAgo(4) });
  s2.set({ key:"USDJPY.primarySetup", claim:"Ninja setup", value:"SHORT the OB 163.8 · T1 163.2",
           confidence:0.6, class:"opportunity", asset:"USDJPY", setAt:hoursAgo(4), invalidator:"1D close > 164" });
  ok("an UNDECLARED opposition is still flagged", C.run(s2,{now:NOW}).events.some(e=>e.type==="BELIEF_CONFLICT"));
}
{
  const s = freshStore();
  s.set({ key:"BTCUSDT.hunch", claim:"BTC hunch", value:"bullish into month end",
          confidence:0.7, class:"structure", asset:"BTCUSDT", setAt:hoursAgo(5) });
  ok("UNGUARDED when a directional belief has no invalidator",
     C.run(s,{now:NOW}).events.some(e=>e.type==="BELIEF_UNGUARDED"));
  ok("doctrine never flagged unguarded",
     !C.run(freshStore(),{now:NOW}).events.some(e=>e.affects && e.affects[0] && e.affects[0].startsWith("doctrine")));
}

/* ══════════ OPPORTUNITY · MOVE CAPTURE ══════════ */

/* parseSetup computes the CAMPAIGN R:R (entry→final target), not the near target */
{
  const p = O.parseSetup("FADE the OB 65,354–66,000 · Stop 66,150 · T1 64,780 / T2 63,666 / T3 63,329 · 1%");
  ok("parses direction from FADE → short", p.dir==="short");
  ok("parses the entry zone", p.zone && p.zone[0]===65354 && p.zone[1]===66000);
  ok("parses the stop", p.stop===66150);
  ok("final target is the FURTHEST (the Bull Line)", p.finalTarget===63329);
  ok("best entry is nearest the invalidation (zone top for a short)", p.entryBest===66000);
  ok("CAMPAIGN R:R is entry→final target, ~17:1 (not the 0.72:1 near-target)",
     p.campaignRR > 15, "campaignRR="+p.campaignRR);
  ok("near-target R:R reported separately", p.nearRR > 5);
  ok("size parsed, not confused with a level", p.size===1);

  const L = O.parseSetup("GOLDEN-ZONE LONG 4,081–4,090 · stop 4,060 · T1 4,117 / T2 4,138 / T3 4,166");
  ok("LONG: best entry is zone bottom (nearest stop below)", L.dir==="long" && L.entryBest===4081);
  ok("LONG: campaign R:R entry→highest target", L.finalTarget===4166 && L.campaignRR > 3);
}

/* THE FIX: a decayed, account-gated setup that scores 0.72:1 at the near target
   is STILL surfaced as the PRIMARY MOVE, because the CAMPAIGN is 17:1. */
{
  const s = freshStore();
  s.set({ key:"BTCUSDT.primarySetup", claim:"BTC OB fade",
          value:"FADE the OB 65,354–66,000 · Stop 66,150 · T1 64,780 / T2 63,666 / T3 63,329 · 1%",
          confidence:0.80, prior:0.5, class:"opportunity", asset:"BTCUSDT",
          setAt:hoursAgo(60), invalidator:"1D close > 67,292" });   // 60h old → heavily decayed
  const r = O.run(s, { now: NOW });
  const pm = r.events.find(e=>e.type==="PRIMARY_MOVE");
  ok("THE MOVE IS SURFACED despite decay + account gate", !!pm, r.events.map(e=>e.type).join(","));
  ok("it is NOT reported as NO_TRADE", !r.events.some(e=>e.type==="NO_TRADE"));
  ok("surfaced with the CAMPAIGN framing (OB Edge → Bull Line)", !!pm && /63329/.test(pm.fact));
  ok("execution scope = watch-only (personal gated, no prop flagged)", !!pm && /WATCH-ONLY/.test(pm.fact));
  ok("tells the operator to enter tight near the invalidation", !!pm && /rejection near 66150/.test(pm.fact));
  ok("decay becomes a RE-CONFIRM note, not a suppressor",
     r.scored[0].notes.some(n=>/re-confirm/i.test(n)));
  ok("PRIMARY_MOVE is tier-1 surfacing (does not clog the reasoning queue)", !!pm && pm.tier===1);
}

/* the account gate SCOPES execution — prop account lifts it to prop-only */
{
  const s = freshStore();
  s.set({ key:"BTCUSDT.primarySetup", claim:"BTC OB fade",
          value:"SHORT 65,354–66,000 · Stop 66,150 · T1 64,780 / T3 63,329",
          confidence:0.6, class:"opportunity", asset:"BTCUSDT", setAt:hoursAgo(2),
          invalidator:"1D close > 67,292" });
  const r = O.run(s, { now: NOW, hasPropAccount:true });
  const pm = r.events.find(e=>e.type==="PRIMARY_MOVE");
  ok("with a prop account the move is PROP-ONLY, still surfaced", !!pm && /PROP-ONLY/.test(pm.fact));
}

/* news window → watch-only, still surfaced (never hidden) */
{
  const s = new BeliefStore("/tmp/bw-news-"+Math.random().toString(36).slice(2)+".json");
  s.set({ key:"BTCUSDT.primarySetup", claim:"BTC OB fade",
          value:"SHORT 65,354–66,000 · Stop 66,150 · T3 63,329",
          confidence:0.6, class:"opportunity", asset:"BTCUSDT", setAt:hoursAgo(2),
          invalidator:"1D close > 67,292" });
  const r = O.run(s, { now: NOW, newsWindow:true });
  const pm = r.events.find(e=>e.type==="PRIMARY_MOVE");
  ok("news window scopes to WATCH-ONLY but still shows the move",
     !!pm && /WATCH-ONLY/.test(pm.fact));
}

/* ENTRY_WINDOW when price is in the zone */
{
  const s = freshStore();
  s.set({ key:"BTCUSDT.primarySetup", claim:"BTC OB fade",
          value:"SHORT 65,354–66,000 · Stop 66,150 · T1 64,780 / T3 63,329",
          confidence:0.6, class:"opportunity", asset:"BTCUSDT", setAt:hoursAgo(2),
          invalidator:"1D close > 67,292" });
  const r = O.run(s, { now: NOW, prices:{ BTCUSDT: 65900 } });
  ok("price IN the zone raises an ENTRY_WINDOW", r.events.some(e=>e.type==="ENTRY_WINDOW"));
}

/* CONTINUATION_WINDOW when the campaign is running and price pulls back */
{
  const s = freshStore();
  s.set({ key:"BTCUSDT.primarySetup", claim:"BTC OB fade",
          value:"SHORT 65,354–66,000 · Stop 66,150 · T3 63,329",
          confidence:0.6, class:"opportunity", asset:"BTCUSDT", setAt:hoursAgo(2),
          invalidator:"1D close > 67,292" });
  /* running: price is 64,600 (below the zone), recent bars dropped to 63,800 then pulled back */
  const recent = [{h:64100,l:63800,c:63900},{h:64300,l:63850,c:64200},{h:64650,l:64100,c:64600}];
  const r = O.run(s, { now: NOW, prices:{ BTCUSDT: 64600 }, recent:{ BTCUSDT: recent } });
  ok("a running campaign with a pullback raises a CONTINUATION_WINDOW",
     r.events.some(e=>e.type==="CONTINUATION_WINDOW"), r.events.map(e=>e.type).join(","));
}

/* NO_TRADE only when there is genuinely no valid campaign */
{
  const s = freshStore();
  s.set({ key:"BTCUSDT.weak", claim:"weak setup",
          value:"SHORT 100–101 · stop 103 · T1 99",   // campaign R:R = (101-99)/(103-101)=1.0 < 2
          confidence:0.6, class:"opportunity", asset:"BTCUSDT", setAt:hoursAgo(2) });
  const r = O.run(s, { now: NOW });
  ok("a sub-2:1 campaign is NOT surfaced as primary", !r.events.some(e=>e.type==="PRIMARY_MOVE"));
  ok("and IS reported as NO_TRADE", r.events.some(e=>e.type==="NO_TRADE"));
}
{
  const s = freshStore();
  const r = O.run(s, { now: NOW });
  ok("an empty book answers NO_TRADE explicitly", r.events.some(e=>e.type==="NO_TRADE"));
  ok("summary is human-readable", /setups/.test(O.summarise(r)), O.summarise(r));
}

console.log(T.join("\n"));
const f = T.filter(x=>x.startsWith("FAIL"));
console.log(f.length ? `\n*** ${f.length} FAIL / ${T.length} ***` : `\nALL ${T.length} PASS`);
process.exit(f.length?1:0);
