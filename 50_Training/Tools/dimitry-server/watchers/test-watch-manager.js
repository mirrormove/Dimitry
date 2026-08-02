/* ============================================================
   WATCH MANAGER TESTS   Vault Intelligence v4 · Step 6
   ============================================================ */
"use strict";
const WM = require("./watch-manager.js");
const { BeliefStore } = require("../belief-store.js");
const T=[], ok=(n,c,x)=>T.push((c?"PASS ":"FAIL ")+n+(c||!x?"":"   → "+x));
const D=s=>Date.parse(s), NOW=D("2026-07-28T12:00:00Z"), hAgo=h=>NOW-h*3.6e6;
const rnd=()=>Math.random().toString(36).slice(2);

function book(){
  const s=new BeliefStore("/tmp/wm-"+rnd()+".json");
  // BTC: armed directional setup → high importance
  s.set({ key:"BTCUSDT.primarySetup", claim:"BTC setup", value:"SHORT the OB 65,354–66,000 · T3 63,329",
          confidence:0.6, class:"opportunity", asset:"BTCUSDT", setAt:hAgo(3), invalidator:"1D close > 67,292" });
  // XAU: bias only → medium
  s.set({ key:"XAUUSD.bias", claim:"Gold bias", value:"slight bull 52/48", confidence:0.52,
          class:"structure", asset:"XAUUSD", setAt:hAgo(3) });
  // GBP: retired setup → low importance, but keep a live invalidator (safety)
  s.set({ key:"GBPUSD.primarySetup", claim:"Cable", value:"RETIRED — golden pocket never reached",
          confidence:0.2, class:"opportunity", asset:"GBPUSD", setAt:hAgo(3), invalidator:"4H close > 1.33934" });
  // USDJPY: bias, no guard
  s.set({ key:"USDJPY.bias", claim:"JPY", value:"50/50 inflection", confidence:0.5, class:"structure", asset:"USDJPY", setAt:hAgo(3) });
  return s;
}

/* ══════════ BUDGET IS BOUNDED ══════════ */
{
  const p = WM.allocate(book(), { now:NOW, budget:1.5 });
  ok("attention is budget-bounded (spend ≤ budget)", p.spent <= 1.5+1e-9, "spent="+p.spent);
  ok("not everything is ACTIVE — attention is scarce", p.active < p.targets.length);
  ok("plan is auditable — every target has a tier + why", p.targets.every(t=>t.tier && t.why));
}

/* ══════════ THE ARMED SETUP WINS ATTENTION ══════════ */
{
  const p = WM.allocate(book(), { now:NOW, budget:1.2 });
  const btc = p.targets.find(t=>t.asset==="BTCUSDT");
  ok("the armed directional setup is ACTIVE (highest EIG)", btc.tier==="ACTIVE");
  ok("targets are ranked by EIG (desc)", p.targets[0].eig >= p.targets[p.targets.length-1].eig);
}

/* ══════════ SAFETY FLOOR — never fully starve a live invalidator ══════════ */
{
  const p = WM.allocate(book(), { now:NOW, budget:1.0 });          // tight budget → GBP not ACTIVE
  const gbp = p.targets.find(t=>t.asset==="GBPUSD");
  ok("a RETIRED setup is not ACTIVE under a tight budget", gbp.tier!=="ACTIVE");
  ok("but its LIVE invalidator keeps it at least LIGHT (tripwire), never HIBERNATE",
     gbp.tier==="LIGHT" && gbp.guardRisk===true, gbp.tier);
  ok("the tripwire carries a wake level", gbp.tripwire && typeof gbp.tripwire.level==="number");
}

/* ══════════ NEAR-ZONE PRICE RAISES ATTENTION ══════════ */
{
  const s = book();
  const far  = WM.attentionScore(s, "BTCUSDT", { now:NOW, prices:{ BTCUSDT: 60000 } });
  const near = WM.attentionScore(s, "BTCUSDT", { now:NOW, prices:{ BTCUSDT: 65700 } });   // inside the zone
  ok("price near the zone raises EIG vs price far away", near.eig > far.eig, `near=${near.eig} far=${far.eig}`);
  ok("the reason names the proximity", near.factors.some(f=>/from the zone/.test(f)));
}

/* ══════════ SESSION WEIGHTING ══════════ */
{
  const tokyo = D("2026-07-28T02:00:00Z");   // Tokyo session
  const ny    = D("2026-07-28T18:00:00Z");   // NY
  ok("USDJPY weighted higher in the Tokyo session", WM.sessionWeight("USDJPY", tokyo) > WM.sessionWeight("USDJPY", ny));
  ok("crypto is always full session", WM.sessionWeight("BTCUSDT", tokyo)===1.0 && WM.sessionWeight("BTCUSDT", ny)===1.0);
}

/* ══════════ SHIFTS + PROPOSALS ══════════ */
{
  const s = book();
  const prior = { targets:[{asset:"BTCUSDT",tier:"HIBERNATE"}] };       // BTC was asleep
  const r = WM.run(s, { now:NOW, budget:1.2, prior });
  ok("waking BTC emits an ATTENTION_SHIFT", r.events.some(e=>e.type==="ATTENTION_SHIFT" && e.asset==="BTCUSDT" && /woke/.test(e.fact)));
  ok("a shift event is tier-1 surfacing (not reasoning)", r.events.filter(e=>e.type==="ATTENTION_SHIFT").every(e=>e.tier===1));
  const r2 = WM.run(s, { now:NOW, budget:1.0 });
  ok("a RETIRED setup with a still-live invalidator is PROPOSED for review (stale guard)",
     r2.events.some(e=>e.type==="PROPOSE_ATTENTION" && e.asset==="GBPUSD"));
  ok("a proposal is tier-2 (needs judgement)", r2.events.filter(e=>e.type==="PROPOSE_ATTENTION").every(e=>e.tier===2));
  ok("summary is human-readable", /attention/.test(WM.summarise(r.plan)));
}

console.log(T.join("\n"));
const f=T.filter(x=>x.startsWith("FAIL"));
console.log(f.length ? `\n*** ${f.length} FAIL / ${T.length} ***` : `\nALL ${T.length} PASS`);
process.exit(f.length?1:0);
