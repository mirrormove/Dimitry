/* ============================================================
   T1 RULE ENGINE             Vault Intelligence v4 · Step 3
   Zero dependencies.

   Applies rules the agent or operator ALREADY WROTE DOWN. It never
   invents a rule and never decides what a broken level MEANS.

   THE LINE (spec §3, inherited from v3):
     When an invalidator fires, the engine marks the belief DEAD —
     confidence collapses to its prior and status becomes "invalidated" —
     and raises a T4 for the agent to re-reason.
     It does NOT write a new direction. Knowing a belief is dead is
     bookkeeping; knowing what replaces it is reasoning.

   This is the bulk of the staleness win: most of what goes stale is an
   invalidation that fired days ago and simply waited for a human to notice.
   ============================================================ */
"use strict";
const { parse, evaluate } = require("./invalidator.js");

/**
 * @param {BeliefStore} store
 * @param {object} candlesByAsset  { BTCUSDT: { "1D":[...], "4H":[...] }, ... }
 * @param {object} opts            { now, dryRun }
 * @returns {{events:Array, updates:Array, unparsed:Array, checked:number}}
 */
function run(store, candlesByAsset, opts){
  opts = opts || {};
  const now = opts.now || Date.now();
  const events = [], updates = [], unparsed = [], unevaluable = [];
  let checked = 0;

  for(const b of store.all(null, now)){
    if(!b.invalidator) continue;
    if(b.status === "invalidated") continue;          // already dead, do not re-fire
    if(b.class === "doctrine") continue;              // doctrine is not evidence-dependent
    checked++;

    const p = parse(b.invalidator, b.asset);
    if(!p.parsed){
      /* surfaced, never silently skipped — you must be able to see which of your
         stated invalidations the machine is NOT watching */
      unparsed.push({ key:b.key, invalidator:b.invalidator, reason:p.unparsed });
      continue;
    }

    const byTf = (candlesByAsset || {})[b.asset] || {};
    /* FOUND ON THE FIRST LIVE RUN: the engine reported "fired: 0" while 10 of 14
       beliefs had NO CANDLES for their asset or timeframe and were never actually
       checked. "Nothing fired" and "nothing could be checked" are completely
       different states, and conflating them is the same silent-skip failure the
       unparseable-invalidator path was built to prevent. */
    const needed = p.clauses.map(c => c.tf);
    const missing = needed.filter(tf => !byTf[tf] || !byTf[tf].length);
    if(missing.length){
      unevaluable.push({ key:b.key, asset:b.asset, invalidator:b.invalidator,
                         missing:[...new Set(missing)],
                         reason: Object.keys(byTf).length ? "timeframe not cached" : "no candles for this asset" });
      continue;
    }
    const ev = evaluate(p, byTf, b.setAt);
    if(!ev.fired){
      /* a price condition met but held back by the belief's own volume gate is
         worth surfacing — it is the le_014 case, and it is NOT an invalidation */
      const partial = (ev.results||[]).find(r => r.res && r.res.partial);
      if(partial) events.push(mkEvent({
        t: partial.res.at, asset:b.asset, type:"INVALIDATOR_PARTIAL", tier:2,
        fact:`"${b.claim}" — price condition met (${partial.clause.tf} close ${partial.clause.dir} `
           + `${partial.clause.level}) but ${partial.res.reason}`,
        evidence:{ key:b.key, clause:partial.clause.raw, close:partial.res.close },
        affects:[b.key]
      }));
      continue;
    }

    const first = ev.firedClauses[0] || {};
    /* 1 · the T4 — highest priority, because the system's own stated condition
           for being wrong has been met */
    events.push(mkEvent({
      t: first.at || now, asset:b.asset, type:"INVALIDATOR_FIRED", tier:4,
      fact:`"${b.claim}" is invalidated — its own stated condition fired: ${b.invalidator}`
         + (first.close != null ? ` (close ${first.close})` : ""),
      evidence:{ key:b.key, invalidator:b.invalidator, join:ev.join,
                 firedClauses:ev.firedClauses, value:b.value,
                 confidenceAtSet:b.confidence, setAt:b.setAt },
      affects:[b.key]
    }));

    /* 2 · mark the belief dead — value preserved for the audit trail,
           confidence collapsed, and explicitly NOT replaced */
    if(!opts.dryRun){
      const rec = store.set({
        key: b.key, claim: b.claim,
        value: b.value,                    // unchanged — the rule does not re-read the market
        confidence: b.prior != null ? b.prior : 0.5,   // collapsed to the prior
        prior: b.prior, class: b.class, halfLifeH: b.halfLifeH, asset: b.asset,
        invalidator: null,                 // it has already fired; it cannot fire twice
        setBy: "rule", setAt: first.at || now,
        source: b.source,
        evidence: (b.evidence || []).concat([{
          k: "INVALIDATED", at: first.at || now, src: "rule:invalidator",
          v: `stated invalidator fired: ${b.invalidator}`
        }])
      });
      rec.status = "invalidated";
      rec.awaitingReasoning = true;        // the agent must supply what replaces it
      updates.push({ key:b.key, uid:rec.uid, was:b.value,
                     confidence:`${(b.confidence*100).toFixed(0)}% → ${((b.prior??0.5)*100).toFixed(0)}%` });
    }
  }

  return { events, updates, unparsed, unevaluable, checked,
           evaluated: checked - unparsed.length - unevaluable.length };
}

let SEQ = 0;
function mkEvent(o){
  return Object.assign({
    id: "rul_" + String(++SEQ).padStart(6,"0"),
    watcher: "rule-engine",
    status: "new",                 // T1/T4 rule output is NOT shadow — these rules are already authorised
    confirm: { basis:"authored-rule" },
    links: { confirms:[], contradicts:[], coOccurs:[] },
    claimedBy: null, processedAt: null, resultBeliefIds: []
  }, o);
}

/** Human-readable summary for the ledger / dashboard. */
function summarise(res){
  const L = [];
  L.push(`${res.checked} beliefs carry an invalidator`);
  L.push(`ACTUALLY EVALUATED: ${res.evaluated}`);
  L.push(`fired: ${res.events.filter(e=>e.type==="INVALIDATOR_FIRED").length}`);
  if(res.unevaluable && res.unevaluable.length)
    L.push(`⚠ COULD NOT EVALUATE ${res.unevaluable.length} (no data): ${res.unevaluable.map(u=>u.key+" ["+u.missing.join("/")+"]").join(", ")}`);
  const partial = res.events.filter(e=>e.type==="INVALIDATOR_PARTIAL").length;
  if(partial) L.push(`partial (price met, gate not): ${partial}`);
  if(res.unparsed.length) L.push(`NOT machine-checkable: ${res.unparsed.length} — ${res.unparsed.map(u=>u.key).join(", ")}`);
  return L.join(" · ");
}

module.exports = { run, summarise };
