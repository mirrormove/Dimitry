/* ============================================================
   RECONCILIATION — setup → execution → outcome, and the LEAK
   Vault Intelligence v4 · Step 3       Zero dependencies.

   Closes the two-scoreboards gap (Doctrine §7, the 2026-06-08 finding: the
   analysis wins and the account leaks). It takes:
     · SETUPS   — what Dimitry generated (parsed from the belief store)
     · INTENTS  — what the operator decided in the app (executed / skipped)
     · FILLS    — what actually happened (extracted from uploads: entry, exit, R)
   and reconciles them into one classified record per trade, tagging the leak.

   The DELTA between the setup and the fill is the behaviour. It classifies:
     followed   a fill that matches an armed setup — was the ENTRY on-location or
                chased LATE? was the winner HELD to target or CUT EARLY?
     off-plan   a fill with no matching setup — impulsive / discretionary (§7)
     skipped    an earned setup the operator marked skipped — the timidity leak

   The aggregate leak counts feed the Ascent engine's impulsivity & timidity axes
   (process-leaks.json). Honest by construction: it only counts decisions the
   operator actually engaged (a fill, or an explicit skip) — never guesses.
   ============================================================ */
"use strict";

const num = x => x==null ? null : +String(x).replace(/,/g,"");
const dirOf = v => /\b(short|sell|fade)\b/i.test(v)?"short":/\b(long|buy)\b/i.test(v)?"long":null;

/** parse a setup belief into structured geometry */
function parseSetupBelief(b){
  const v=String(b.value||""), dir=dirOf(v);
  const zm=v.match(/(\d[\d,]*(?:\.\d+)?)\s*[–—-]\s*(\d[\d,]*(?:\.\d+)?)/);
  const zone=zm?[num(zm[1]),num(zm[2])].sort((a,b)=>a-b):null;
  const stop=num((v.match(/stop\s*\$?\s*([\d,]+(?:\.\d+)?)/i)||[])[1]);
  const targets=[...v.matchAll(/\bT\d\s*\$?\s*([\d,]+(?:\.\d+)?)/gi)].map(m=>num(m[1]));
  const bestEntry = zone ? (dir==="short"?zone[1]:zone[0]) : null;   // tight entry nearest the stop
  const t1R = (zone && stop && targets[0]) ? Math.abs(targets[0]-bestEntry)/Math.max(1e-9,Math.abs(bestEntry-stop)) : null;
  return { key:b.key, asset:b.asset, dir, zone, stop, targets, bestEntry, t1R:t1R==null?null:+t1R.toFixed(2), retired:/RETIRED|no trade/i.test(v) };
}
function setupsFromBeliefs(beliefs){
  return (beliefs||[]).filter(b=>b.class==="opportunity"&&b.value).map(parseSetupBelief).filter(s=>s.dir&&s.zone);
}

/** where did the entry land relative to the zone? on-location / late (chased) / early (front-run) */
function classifyEntry(fill, s){
  if(fill.entry==null || !s.zone) return "unknown";
  const [lo,hi]=s.zone, tol=Math.max((hi-lo)*0.25, hi*0.0015), e=fill.entry;
  if(e>=lo-tol && e<=hi+tol) return "on";
  return s.dir==="short" ? (e<lo-tol?"late":"early") : (e>hi+tol?"late":"early");
}
/** management quality: held / cut-early / stopped */
function classifyMgmt(fill, s){
  if(fill.r==null) return null;
  if(fill.r<0) return "stopped";
  /* cut early = a winner banked well short of what was available. Uses the trade's own
     max-favourable-excursion (mfeR) when present, else the setup's first target. */
  if(fill.mfeR!=null && fill.mfeR>=1 && fill.r < 0.5*fill.mfeR) return "cut-early";
  if(s && s.t1R && fill.reachedT1 && fill.r < 0.6*s.t1R) return "cut-early";
  return "held";
}

/**
 * @param {Array} fills   [{asset, dir, entry, exit?, size?, stop?, r?, mfeR?, reachedT1?, at?}]
 * @param {Array} setups  parsed (setupsFromBeliefs) or structured
 * @param {Array} intents [{setupKey, asset, dir, intent:"executed"|"skipped", params, at}]
 */
function reconcile(fills, setups, intents, opts){
  opts=opts||{}; fills=fills||[]; setups=setups||[]; intents=intents||[];
  const records=[], skipped=[];

  for(const f of fills){
    const dir=f.dir||null;
    const cand=setups.filter(s=>s.asset===f.asset && s.dir===dir && s.zone && !s.retired);
    let match=null, best=Infinity;
    for(const s of cand){ const mid=(s.zone[0]+s.zone[1])/2; const d=Math.abs((f.entry-mid)/mid);
      if(d<best){ best=d; match=s; } }
    if(match && best<=0.03){                                   // within 3% of the zone → followed this setup
      const loc=classifyEntry(f,match), mgmt=classifyMgmt(f,match), leaks=[];
      if(loc==="late") leaks.push("late-entry"); if(loc==="early") leaks.push("front-run");
      if(mgmt==="cut-early") leaks.push("cut-early");
      const disc=Math.max(0, 10 - (loc==="late"?3:loc==="early"?2:0) - (mgmt==="cut-early"?3:0));
      records.push({ asset:f.asset, dir, class:"followed", setupKey:match.key, location:loc, management:mgmt, r:f.r??null, leaks, discipline:disc });
    } else {
      const mgmt=classifyMgmt(f,{});
      records.push({ asset:f.asset, dir, class:"off-plan", setupKey:null, location:"off-plan", management:mgmt, r:f.r??null, leaks:["off-plan"], discipline:3 });
    }
  }

  /* skipped-earned = the operator explicitly marked an armed setup skipped (the honest timidity signal) */
  for(const i of intents.filter(x=>x.intent==="skipped")){
    const s=setups.find(x=>x.key===i.setupKey);
    if(!s || !s.retired) skipped.push({ setupKey:i.setupKey, asset:(s&&s.asset)||i.asset, reason:"marked-skipped" });
  }

  const followed=records.filter(r=>r.class==="followed"), offPlan=records.filter(r=>r.class==="off-plan");
  const late=followed.filter(r=>r.location==="late"), cutEarly=followed.filter(r=>r.management==="cut-early");
  const decisions=fills.length+skipped.length;             // opportunities the operator actually engaged
  const leaks={
    impulsivity:{ impulsiveEntries: offPlan.length+late.length, opportunities: decisions },
    timidity:{ skippedEarnedSetups: skipped.length, winnersCutEarly: cutEarly.length, earnedOpportunities: decisions }
  };
  const avgDisc = records.length ? +(records.reduce((a,r)=>a+r.discipline,0)/records.length).toFixed(1) : null;
  return { records, skipped, leaks, avgDiscipline:avgDisc,
    summary:`${records.length} fill(s) · ${followed.length} on-plan · ${offPlan.length} off-plan · ${late.length} late · ${cutEarly.length} cut-early · ${skipped.length} skipped-earned` };
}

function main(){
  const fs=require("fs"), path=require("path");
  const T=path.resolve(__dirname,"..","..");
  const read=f=>{ try{ return fs.readFileSync(path.resolve(T,f),"utf8").trim().split("\n").filter(Boolean).map(JSON.parse); }catch(e){ return []; } };
  const intents=read("executions.ndjson"), fills=read("fills.ndjson");
  let beliefs=[]; try{ const {BeliefStore}=require("../belief-store.js"); beliefs=new BeliefStore(path.resolve(T,"beliefs.json")).load().all(null,Date.now()); }catch(e){}
  const r=reconcile(fills, setupsFromBeliefs(beliefs), intents, {});
  fs.writeFileSync(path.resolve(T,"reconciliation.json"), JSON.stringify(r,null,2));
  fs.writeFileSync(path.resolve(T,"process-leaks.json"),
    JSON.stringify({ updated:Date.now(), fedBy:["reconcile"], impulsivity:r.leaks.impulsivity, timidity:r.leaks.timidity }, null, 2));
  console.log("RECONCILE —", r.summary, "· avg discipline", r.avgDiscipline);
  console.log("  leaks →", JSON.stringify(r.leaks));
}
if(require.main===module) main();
module.exports = { reconcile, setupsFromBeliefs, parseSetupBelief, classifyEntry, classifyMgmt };
