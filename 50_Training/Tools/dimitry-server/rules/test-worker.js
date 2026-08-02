/* ============================================================
   WORKER + AUTO-DISPOSITION TESTS   Vault Intelligence v4 · closing the loop
   ============================================================ */
"use strict";
const { autoDisposition } = require("./auto-disposition.js");
const { runWorker, validateUpdate } = require("./worker.js");
const { EventLog } = require("../watchers/event-log.js");
const { BeliefStore } = require("../belief-store.js");

const T=[], ok=(n,c,x)=>T.push((c?"PASS ":"FAIL ")+n+(c||!x?"":"   → "+x));
const D=s=>Date.parse(s), NOW=D("2026-07-28T12:00:00Z"), hAgo=h=>NOW-h*3.6e6;
const rnd=()=>Math.random().toString(36).slice(2);
const rig=()=>({ log:new EventLog("/tmp/wk-"+rnd()+".ndjson"), store:new BeliefStore("/tmp/wk-"+rnd()+".json") });
const ev=(o)=>Object.assign({ id:"e_"+rnd(), status:"new", watcher:"test", claimedBy:null, processedAt:null, resultBeliefIds:[] }, o);

async function main(){

/* ══════════ AUTO-DISPOSITION · the decayed bulk ══════════ */
{
  const {store}=rig();
  store.set({ key:"BTCUSDT.primarySetup", claim:"BTC setup", value:"SHORT the OB 65,354–66,000 · T3 63,329",
              confidence:0.8, prior:0.5, halfLifeH:48, class:"opportunity", asset:"BTCUSDT",
              setAt:hAgo(60), setBy:"agent", invalidator:"1D close > 67,292" });
  const events=[ ev({type:"BELIEF_DECAYED",tier:4,asset:"BTCUSDT",affects:["BTCUSDT.primarySetup"],fact:"decayed"}) ];
  const r=autoDisposition(events, store, {now:NOW});
  ok("a decayed, uncontested belief is RE-AFFIRMED (an update)", r.updates.length===1 && r.updates[0].key==="BTCUSDT.primarySetup");
  ok("re-affirm keeps the value (no new conviction invented)", /SHORT the OB/.test(r.updates[0].value));
  ok("re-affirm keeps the invalidator", r.updates[0].invalidator==="1D close > 67,292");
  ok("the decay event is resolved by the rule (no LLM)", r.resolvedEventIds.length===1 && r.escalateEventIds.length===0);
}
{
  /* a decayed belief that is ALSO in a REAL conflict must NOT be auto-re-affirmed */
  const {store}=rig();
  store.set({ key:"BTCUSDT.primarySetup", claim:"BTC setup", value:"LONG 63,330", confidence:0.8, prior:0.5,
              halfLifeH:48, class:"opportunity", asset:"BTCUSDT", setAt:hAgo(60), setBy:"agent", invalidator:"x" });
  store.set({ key:"BTCUSDT.bias", claim:"BTC bias", value:"bear 60/40", confidence:0.6, class:"structure",
              asset:"BTCUSDT", setAt:hAgo(5) });
  const events=[
    ev({type:"BELIEF_DECAYED",tier:4,asset:"BTCUSDT",affects:["BTCUSDT.primarySetup"],fact:"decayed"}),
    ev({type:"BELIEF_CONFLICT",tier:3,asset:"BTCUSDT",affects:["BTCUSDT.primarySetup","BTCUSDT.bias"],fact:"long vs bear bias"})
  ];
  const r=autoDisposition(events, store, {now:NOW});
  ok("a CONTESTED decayed belief is escalated, not auto-re-affirmed", r.updates.length===0 && r.escalateEventIds.length===2);
}
{
  const {store}=rig();
  store.set({ key:"correlation.usdtd.btc", claim:"USDT.D→BTC", value:"inverse, proven lead",
              confidence:0.62, class:"correlation", setAt:hAgo(100), setBy:"agent" });
  store.set({ key:"USDJPY.primarySetup", claim:"JPY", value:"SHORT — deliberate counter-trend fade",
              confidence:0.6, class:"opportunity", asset:"USDJPY", setAt:hAgo(4) });
  const events=[
    ev({type:"CORRELATION_UNGUARDED",tier:2,affects:["correlation.usdtd.btc"],fact:"no invalidator"}),
    ev({type:"NEWS_AHEAD",tier:2,affects:["macro.fomc"],fact:"FOMC in 45h"}),
    ev({type:"BELIEF_CONFLICT",tier:3,asset:"USDJPY",affects:["USDJPY.primarySetup"],fact:"short vs bull"}),
    ev({type:"INVALIDATOR_FIRED",tier:4,asset:"XAUUSD",affects:["XAUUSD.mustHold"],fact:"gold line broke"})
  ];
  const r=autoDisposition(events, store, {now:NOW});
  const guard=r.updates.find(u=>u.key==="correlation.usdtd.btc");
  ok("an unguarded correlation gets a templated decoupling invalidator", !!guard && /decoupled/.test(guard.invalidator));
  ok("a NEWS scope flag is dismissed (resolved, no belief)", r.resolvedEventIds.length===3);   // corr + news + counter-trend conflict
  ok("a DECLARED counter-trend conflict is dismissed", !r.escalateEventIds.some(id=>events.find(e=>e.id===id&&e.type==="BELIEF_CONFLICT")));
  ok("an INVALIDATOR_FIRED is escalated (needs judgement)", r.escalateEventIds.length===1);
}

/* ══════════ THE CLOSED LOOP · Tier-0 worker, no model ══════════ */
{
  const {log,store}=rig();
  store.set({ key:"GBPUSD.bias", claim:"Cable bias", value:"bear 58/42", confidence:0.8, prior:0.5,
              halfLifeH:48, class:"structure", asset:"GBPUSD", setAt:hAgo(60), setBy:"agent",
              invalidator:"4H close > 1.33934" });
  ok("PRE: the stale belief WOULD fire a decay event", store.sweep(NOW).some(e=>e.affects[0]==="GBPUSD.bias"));
  log.append([ ev({type:"BELIEF_DECAYED",tier:4,asset:"GBPUSD",affects:["GBPUSD.bias"],fact:"decayed 60h",t:hAgo(1)}) ]);

  const r=await runWorker(log, store, {now:NOW});
  ok("worker settled it at Tier 0 (deterministic, no model)", r.tier0===1 && r.tier1===0 && r.escalated===0);
  ok("the belief was re-affirmed by the agent-of-record", store.get("GBPUSD.bias",NOW).setBy==="agent");
  ok("the event is now processed (unprocessed → 0)", log.unprocessedCount()===0);
  /* THE CLOSURE: clock reset means the same belief will NOT re-fire decay next cycle */
  ok("LOOP CLOSED — re-affirmed belief no longer fires a decay event", !store.sweep(NOW).some(e=>e.affects[0]==="GBPUSD.bias"));
}

/* ══════════ TIER 1 · a fallback model, gated ══════════ */
{
  const {log,store}=rig();
  const dead=store.set({ key:"XAUUSD.mustHold", claim:"Gold line", value:4081, confidence:0.5, prior:0.5,
              class:"structure", asset:"XAUUSD", setAt:hAgo(2), setBy:"rule", invalidator:null });
  dead.status="invalidated"; dead.awaitingReasoning=true;
  log.append([ ev({type:"INVALIDATOR_FIRED",tier:4,asset:"XAUUSD",affects:["XAUUSD.mustHold"],fact:"gold closed below 4,081",t:hAgo(1)}) ]);

  /* a GOOD model answer — valid replacement with a new invalidator */
  const goodModel = async () => ({ updates:[{ key:"XAUUSD.mustHold", claim:"Gold line", value:"bear resumes — 4,039 next",
     confidence:0.6, class:"structure", asset:"XAUUSD", invalidator:"1D close back above 4,081" }] });
  const r1=await runWorker(log, store, {now:NOW, reasoner:goodModel});
  ok("a VALID model answer is applied at Tier 1", r1.tier1===1 && r1.escalated===0 && r1.rejected===0);
  ok("the belief now carries the model's new invalidator", store.get("XAUUSD.mustHold",NOW).invalidator==="1D close back above 4,081");
}
{
  const {log,store}=rig();
  store.set({ key:"BTCUSDT.bias", claim:"BTC bias", value:"range", confidence:0.5, class:"structure",
              asset:"BTCUSDT", setAt:hAgo(2), setBy:"rule", invalidator:null }).status="invalidated";
  log.append([ ev({type:"INVALIDATOR_FIRED",tier:4,asset:"BTCUSDT",affects:["BTCUSDT.bias"],fact:"fired",t:hAgo(1)}) ]);

  /* BAD answers: doctrine write, and a replacement with NO invalidator */
  const badModel = async () => ({ updates:[
     { key:"doctrine.stopCeil.crypto", value:99, class:"doctrine", invalidator:"never" },
     { key:"BTCUSDT.bias", value:"bull", class:"structure", asset:"BTCUSDT" }          // no invalidator
  ]});
  const r=await runWorker(log, store, {now:NOW, reasoner:badModel});
  ok("the model may NOT write doctrine (rejected)", r.rejects.some(x=>/doctrine/.test(x.reason)));
  ok("a replacement with no invalidator is rejected (falsifiability gate)", r.rejects.some(x=>/invalidator/.test(x.reason)));
  ok("rejected answers leave the event ESCALATED, not silently applied", r.escalated===1 && r.tier1===0);
  ok("validateUpdate flags a key outside the brief", validateUpdate({key:"X.y",class:"structure",invalidator:"z"}, new Set(["A.b"]))!==null);
}

console.log(T.join("\n"));
const f=T.filter(x=>x.startsWith("FAIL"));
console.log(f.length ? `\n*** ${f.length} FAIL / ${T.length} ***` : `\nALL ${T.length} PASS`);
process.exit(f.length?1:0);
}
main();
