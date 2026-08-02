/* ============================================================
   DRAIN TESTS                Vault Intelligence v4 · Step 7
   ============================================================ */
"use strict";
const { claim, apply, briefMarkdown } = require("./drain.js");
const { EventLog } = require("../watchers/event-log.js");
const { BeliefStore } = require("../belief-store.js");
const fs = require("fs");

const T=[], ok=(n,c,x)=>T.push((c?"PASS ":"FAIL ")+n+(c||!x?"":"   → "+x));
const D=s=>Date.parse(s), NOW=D("2026-07-28T12:00:00Z"), hAgo=h=>NOW-h*3.6e6;
const rnd=()=>Math.random().toString(36).slice(2);

function rig(){
  const lf="/tmp/drain-"+rnd()+".ndjson", bf="/tmp/drain-"+rnd()+".json";
  const log=new EventLog(lf), store=new BeliefStore(bf);
  store.set({ key:"doctrine.stopCeil.crypto", claim:"Max stop drawdown — crypto",
              value:1.2, confidence:1, class:"doctrine", setBy:"operator", setAt:hAgo(300) });
  return { log, store };
}
const ev=(o)=>Object.assign({ id:"e_"+rnd(), status:"new", watcher:"test",
  claimedBy:null, processedAt:null, resultBeliefIds:[] }, o);

/* ══════════ PRIORITY + COALESCING ══════════ */
{
  const {log,store}=rig();
  store.set({key:"BTCUSDT.bias",claim:"BTC bias",value:"range",confidence:0.51,class:"structure",asset:"BTCUSDT",setAt:hAgo(20)});
  store.set({key:"XAUUSD.bias",claim:"Gold bias",value:"bull",confidence:0.6,class:"structure",asset:"XAUUSD",setAt:hAgo(20)});
  log.append([
    ev({t:hAgo(1), asset:"BTCUSDT", type:"BOS_CONFIRMED",    tier:2, fact:"structure moved", affects:["BTCUSDT.bias"]}),
    ev({t:hAgo(2), asset:"BTCUSDT", type:"LEVEL_BREAK",      tier:2, fact:"level broke",     affects:["BTCUSDT.bias"]}),
    ev({t:hAgo(3), asset:"XAUUSD",  type:"INVALIDATOR_FIRED",tier:4, fact:"gold invalidated",affects:["XAUUSD.bias"]}),
    ev({t:hAgo(1), asset:"BTCUSDT", type:"EVENT_PRINTED",    tier:3, fact:"CPI printed",     affects:["BTCUSDT.bias"]}),
    ev({t:hAgo(9), asset:null,      type:"NO_TRADE",         tier:2, fact:"stand down",      affects:[]})
  ]);
  const c=claim(log,store,{now:NOW,dryRun:true});
  ok("coalesces into one pass per asset", c.briefs.length===3, "briefs="+c.briefs.length);
  const btc=c.briefs.find(b=>b.asset==="BTCUSDT");
  ok("three BTC events become ONE reasoning pass", btc && btc.events.length===3, btc&&btc.events.length);
  ok("T4 is claimed first", c.claimed.length===5 && log.claimable().length===5);
  const order=c.briefs.flatMap(b=>b.events).map(e=>e.tier);
  ok("priority is T4 → T3 → T2", order[0]===4, "order="+order.join(","));
}

/* ══════════ THE BRIEF IS SCOPED ══════════ */
{
  const {log,store}=rig();
  store.set({key:"BTCUSDT.bias",claim:"BTC bias",value:"range",confidence:0.51,class:"structure",asset:"BTCUSDT",setAt:hAgo(20)});
  store.set({key:"BTCUSDT.noise",claim:"unrelated",value:"x",confidence:0.6,class:"flow",asset:"BTCUSDT",setAt:hAgo(20)});
  store.set({key:"EURUSD.bias",claim:"EUR bias",value:"bear",confidence:0.6,class:"structure",asset:"EURUSD",setAt:hAgo(20)});
  log.append([ev({t:hAgo(1),asset:"BTCUSDT",type:"BOS_CONFIRMED",tier:2,fact:"moved",affects:["BTCUSDT.bias"]})]);
  const c=claim(log,store,{now:NOW,dryRun:true});
  const keys=c.briefs[0].beliefs.map(b=>b.key);
  ok("brief carries ONLY the affected belief", keys.length===1 && keys[0]==="BTCUSDT.bias", keys.join(","));
  ok("doctrine always travels with the brief", c.briefs[0].doctrine.length===1);
  ok("unrelated assets are excluded", !keys.includes("EURUSD.bias"));
}

/* ══════════ awaitingReasoning IS PICKED UP (K13) ══════════ */
{
  const {log,store}=rig();
  const dead=store.set({key:"XAUUSD.bias",claim:"Gold bias",value:"bull 52/48",
    confidence:0.5,class:"structure",asset:"XAUUSD",setAt:hAgo(5)});
  dead.status="invalidated"; dead.awaitingReasoning=true;
  log.append([ev({t:hAgo(5),asset:"XAUUSD",type:"INVALIDATOR_FIRED",tier:4,
    fact:"gold bias invalidated",affects:["XAUUSD.bias"]})]);
  const c=claim(log,store,{now:NOW,dryRun:true});
  const b=c.briefs[0].beliefs.find(x=>x.key==="XAUUSD.bias");
  ok("a dead belief reaches the brief flagged awaiting", b && b.awaitingReasoning===true && b.status==="invalidated");
  ok("the brief ASKS what replaces it",
     c.briefs[0].asked.some(q=>/what replaces it/i.test(q)), c.briefs[0].asked.join(" | ").slice(0,80));
}

/* ══════════ APPLY — the agent's answer is recorded ══════════ */
{
  const {log,store}=rig();
  const dead=store.set({key:"XAUUSD.bias",claim:"Gold bias",value:"slight bull 52/48",
    confidence:0.5,prior:0.5,class:"structure",asset:"XAUUSD",setAt:hAgo(5)});
  dead.status="invalidated"; dead.awaitingReasoning=true;
  const e1=ev({t:hAgo(5),asset:"XAUUSD",type:"INVALIDATOR_FIRED",tier:4,fact:"invalidated",affects:["XAUUSD.bias"]});
  log.append([e1]);
  const c=claim(log,store,{now:NOW});
  ok("claiming marks events claimed", log.claimable().length===0);

  const r=apply(log,store,[{
    key:"XAUUSD.bias", claim:"Gold bias", value:"bear 58/42 — CHoCH failed",
    confidence:0.58, class:"structure", asset:"XAUUSD",
    invalidator:"1D close > 4,138",
    evidence:[{k:"INVALIDATION",v:"1D closed below 4,081",at:hAgo(5)}]
  }], c.claimed, {now:NOW});

  ok("belief written by the AGENT", r.written.length===1);
  const after=store.get("XAUUSD.bias",NOW);
  ok("value replaced", after.value==="bear 58/42 — CHoCH failed");
  ok("setBy records the agent, not a rule", after.setBy==="agent");
  ok("status back to active", after.status==="active");
  ok("awaitingReasoning cleared (K13 closed)", after.awaitingReasoning===false);
  ok("a NEW invalidator was required", after.invalidator==="1D close > 4,138");
  ok("history preserved — the dead record survives", store.history("XAUUSD.bias").length===2);
  ok("event marked processed", r.processed.length===1);
  ok("nothing left claimable", log.claimable().length===0);

  const again=apply(log,store,[],c.claimed,{now:NOW});
  ok("IDEMPOTENT — reprocessing is a no-op", again.processed.length===0);
}

/* ══════════ GUARDS ══════════ */
{
  const {log,store}=rig();
  let threw=false;
  try{ apply(log,store,[{value:"x"}],[],{now:NOW}); }catch(e){ threw=true; }
  ok("rejects a belief update with no key/class", threw);

  const c=claim(log,store,{now:NOW});
  ok("an empty queue is handled, not crashed", c.empty===true);
  ok("empty brief renders", /queue empty/i.test(briefMarkdown(c)));
}

/* ══════════ THE BRIEF READS LIKE A BRIEFING ══════════ */
{
  const {log,store}=rig();
  store.set({key:"BTCUSDT.bias",claim:"BTC bias",value:"range 49/51",confidence:0.51,class:"structure",asset:"BTCUSDT",setAt:hAgo(30)});
  log.append([ev({t:hAgo(1),asset:"BTCUSDT",type:"BELIEF_CONFLICT",tier:3,
    fact:"setup opposes its bias",affects:["BTCUSDT.bias"]})]);
  const md=briefMarkdown(claim(log,store,{now:NOW,dryRun:true}));
  ok("brief names the asset", /## BTCUSDT/.test(md));
  ok("brief lists what fired", /BELIEF_CONFLICT/.test(md));
  ok("brief states the question", /counter-trend/i.test(md));
  ok("brief carries doctrine", /Max stop drawdown/.test(md));
  ok("brief says the bookkeeping is already done", /needs judgement/i.test(md));
}

console.log(T.join("\n"));
const f=T.filter(x=>x.startsWith("FAIL"));
console.log(f.length?`\n*** ${f.length} FAIL / ${T.length} ***`:`\nALL ${T.length} PASS`);
process.exit(f.length?1:0);
