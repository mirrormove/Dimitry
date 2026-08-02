/* ============================================================
   DRAIN WORKER — the closed, tiered reasoning loop
   Vault Intelligence v4 · closing the loop (K39 transport)   Zero deps.

   Turns the drain's claim/brief/apply contract into an autonomous loop that
   runs WITHOUT the primary agent, degrading gracefully by tier:

     Tier 0 · deterministic   auto-disposition settles the mechanical bulk
                              (decay re-affirm, dismiss scope flags, guard a
                              correlation). No model. Always available.
     Tier 1 · fallback model  a pluggable reasoner (Haiku / any provider /
                              local) handles the judgement calls via the SAME
                              apply() protocol. Its output is VALIDATED against
                              the honesty gates before it can touch a belief —
                              so a weaker brain cannot corrupt the store.
     Tier 2 · escalate        anything with no rule and no valid model answer is
                              left awaiting the primary agent. Never guessed.

   The gates, not the model, are what make a fallback safe: they live here.
   ============================================================ */
"use strict";
const { claim, apply, briefMarkdown } = require("./drain.js");
const { autoDisposition } = require("./auto-disposition.js");

/* A reasoned belief update may only be applied if it clears EVERY gate. */
function validateUpdate(u, allowedKeys){
  if(!u || typeof u !== "object")      return "not an object";
  if(!u.key || !u.class)               return "missing key/class";
  if(u.class === "doctrine")           return "doctrine is operator-only — a model may not write it";
  if(allowedKeys && !allowedKeys.has(u.key)) return `key ${u.key} is not in the brief`;
  if(!u.invalidator || !String(u.invalidator).trim())
                                       return "a replacement belief needs a NEW invalidator (falsifiability)";
  return null;                         // valid
}

/**
 * Run one worker cycle.
 * @param {EventLog} log
 * @param {BeliefStore} store
 * @param {object} opts {now, max, reasoner}
 *   reasoner(briefMd, escalatedEvents, store) → { updates:[...] } | Promise<...>
 *   Omit it to run Tier-0 only (fully deterministic, always safe).
 */
async function runWorker(log, store, opts){
  opts = opts || {};
  const now = opts.now || Date.now();
  const claimed = claim(log, store, { max: opts.max || 50, by: "worker", now });
  if(claimed.empty) return { empty:true, tier0:0, tier1:0, escalated:0, rejected:0,
                             summary:"queue empty — nothing to reason about" };

  const events = claimed.briefs.flatMap(b => b.events);

  /* ---- Tier 0 · deterministic ---- */
  const auto = autoDisposition(events, store, { now });
  const t0 = apply(log, store, auto.updates, auto.resolvedEventIds, { now });

  let tier1 = 0, rejected = 0, rejects = [];
  let escalateIds = auto.escalateEventIds;

  /* ---- Tier 1 · fallback model (only for what Tier 0 escalated) ---- */
  if(opts.reasoner && escalateIds.length){
    const escEvents = events.filter(e => escalateIds.includes(e.id));
    const allowedKeys = new Set(escEvents.flatMap(e => e.affects || []));
    const subBrief = { empty:false, briefs: claimed.briefs
        .map(b => ({ ...b, events: b.events.filter(e => escalateIds.includes(e.id)) }))
        .filter(b => b.events.length),
      summary:`${escEvents.length} escalated event(s)` };

    let answer;
    try { answer = await opts.reasoner(briefMarkdown(subBrief), escEvents, store); }
    catch(e){ answer = { updates:[], error:String(e.message||e) }; }

    const good = [], coveredKeys = new Set();
    for(const u of (answer && answer.updates) || []){
      const bad = validateUpdate(u, allowedKeys);
      if(bad){ rejected++; rejects.push({ key:u && u.key, reason:bad }); }
      else { good.push(u); coveredKeys.add(u.key); }
    }
    /* an escalated event is resolved only if the model produced a VALID update for a belief it affects */
    const nowResolved = escEvents.filter(e => (e.affects||[]).some(k => coveredKeys.has(k))).map(e => e.id);
    if(good.length || nowResolved.length){
      const t1 = apply(log, store, good, nowResolved, { now });
      tier1 = t1.written.length;
    }
    escalateIds = escalateIds.filter(id => !nowResolved.includes(id));
  }

  /* ---- Tier 2 · whatever is left stays claimed, awaiting the primary agent ---- */
  return {
    empty:false,
    claimed: claimed.claimed.length,
    tier0: t0.processed.length, tier0Beliefs: t0.written.length,
    tier1, rejected, rejects,
    escalated: escalateIds.length, escalatedIds: escalateIds,
    autoLog: auto.log,
    summary: `claimed ${claimed.claimed.length} · Tier0 settled ${t0.processed.length} (${t0.written.length} beliefs) · `
           + `Tier1 reasoned ${tier1}${rejected?` · REJECTED ${rejected}`:""} · Tier2 awaiting ${escalateIds.length}`
  };
}

module.exports = { runWorker, validateUpdate };
