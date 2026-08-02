/* ============================================================
   AUTO-DISPOSITION (Tier 0)     Vault Intelligence v4 · closing the loop
   Zero dependencies. Zero LLM.

   Most of a drain queue is NOT reasoning — it is bookkeeping that a rule can
   settle. The 457-event pile of 2026-07-28 was 388 "this belief decayed by
   time" events: mechanical. This layer settles the mechanical ones
   deterministically and ESCALATES only what genuinely needs judgement.

   THE ONE THAT CLOSES THE LOOP — re-affirming a decayed belief. A belief that
   is stale purely by TIME (no contradiction against it in the batch) is
   re-affirmed at its current, honestly-decayed confidence with the clock reset.
   That reset is what stops the recurrence: a re-affirmed belief will not re-fire
   BELIEF_DECAYED for another half-life. No new conviction is invented.

   Escalated (needs a model / the primary agent):
     INVALIDATOR_FIRED · BELIEF_ORPHANED · BELIEF_UNGUARDED · REGIME_CONFLICT ·
     an UNRECONCILED conflict · any structure-move · a contested belief.
   ============================================================ */
"use strict";

const DISMISS = new Set(["NEWS_AHEAD", "NEWS_WINDOW"]);          // live scope flags, already consumed
const ESCALATE_TYPES = new Set([
  "INVALIDATOR_FIRED", "BELIEF_ORPHANED", "BELIEF_UNGUARDED", "REGIME_CONFLICT",
  "EV_DEGRADED", "BOS_CONFIRMED", "CHOCH_CONFIRMED", "LEVEL_BREAK"
]);
const declaresCounterTrend = v => /counter-?trend|counter-?momentum|by design/i.test(String(v||""));

/**
 * @param {Array} events  claimed events (each {id,type,tier,affects,evidence,fact})
 * @param {BeliefStore} store
 * @param {object} opts {now}
 * @returns {{updates, resolvedEventIds, escalateEventIds, log}}
 */
function autoDisposition(events, store, opts){
  opts = opts || {};
  const now = opts.now || Date.now();
  const updates = [], log = [];
  const resolved = new Set(), escalate = new Set();
  const bump = (id, set) => set.add(id);

  /* which beliefs are CONTESTED in this batch (an escalate-grade event touches them)?
     a decayed belief that is ALSO in a real conflict must NOT be auto-re-affirmed. */
  const contested = new Set();
  for(const e of events){
    const isRealConflict = e.type === "BELIEF_CONFLICT" &&
      !declaresCounterTrend((store.get((e.affects||[])[0], now)||{}).value);
    if(ESCALATE_TYPES.has(e.type) || isRealConflict)
      (e.affects || []).forEach(k => contested.add(k));
  }

  for(const e of events){
    const key = (e.affects || [])[0] || null;

    /* 1 · live scope flags — dismiss, no belief change */
    if(DISMISS.has(e.type)){ bump(e.id, resolved); log.push(`dismiss ${e.type} (${key||"global"}): scope flag, already consumed`); continue; }

    /* 2 · a DECLARED counter-trend conflict — acknowledged by authorship */
    if(e.type === "BELIEF_CONFLICT"){
      const setup = store.get(key, now);
      if(setup && declaresCounterTrend(setup.value)){ bump(e.id, resolved); log.push(`dismiss BELIEF_CONFLICT (${key}): declared counter-trend`); continue; }
      bump(e.id, escalate); log.push(`escalate BELIEF_CONFLICT (${key}): unreconciled`); continue;
    }

    /* 3 · a correlation with no decoupling condition — add a templated invalidator */
    if(e.type === "CORRELATION_UNGUARDED"){
      const b = store.get(key, now);
      if(b && !b.invalidator){
        updates.push({ key:b.key, claim:b.claim, value:b.value, confidence:b.confidenceNow,
          prior:b.prior, class:b.class, asset:b.asset,
          invalidator:"the stated relationship prints same-direction daily closes 3 sessions running (decoupled)",
          evidence:[{ k:"AUTO_GUARDED", at:now, src:"auto-disposition",
                      v:"added a decoupling condition so the correlation is falsifiable" }],
          source:b.source });
        bump(e.id, resolved); log.push(`guard CORRELATION_UNGUARDED (${key}): added decoupling invalidator`);
      } else { bump(e.id, resolved); log.push(`dismiss CORRELATION_UNGUARDED (${key}): already guarded`); }
      continue;
    }

    /* 4 · escalate-grade events — needs judgement */
    if(ESCALATE_TYPES.has(e.type)){ bump(e.id, escalate); log.push(`escalate ${e.type} (${key||"global"})`); continue; }

    /* 5 · DECAYED — the bulk. Re-affirm if the belief is NOT contested; else escalate. */
    if(e.type === "BELIEF_DECAYED"){
      if(key && contested.has(key)){ bump(e.id, escalate); log.push(`escalate BELIEF_DECAYED (${key}): belief is contested this batch`); continue; }
      const b = store.get(key, now);
      if(!b){ bump(e.id, resolved); log.push(`dismiss BELIEF_DECAYED (${key}): belief no longer present`); continue; }
      /* re-affirm at the honestly-decayed confidence, clock reset, invalidator kept */
      updates.push({ key:b.key, claim:b.claim, value:b.value, confidence:+b.confidenceNow.toFixed(3),
        prior:b.prior, class:b.class, asset:b.asset, invalidator:b.invalidator,
        evidence:[{ k:"RE-AFFIRMED", at:now, src:"auto-disposition",
                    v:`stale by time (${b.ageH.toFixed(0)}h), no contradicting evidence — held at decayed confidence, clock reset` }],
        source:b.source });
      bump(e.id, resolved); log.push(`re-affirm BELIEF_DECAYED (${key}): held @ ${(b.confidenceNow*100).toFixed(0)}%, clock reset`);
      continue;
    }

    /* 6 · anything unrecognised — escalate rather than silently drop */
    bump(e.id, escalate); log.push(`escalate ${e.type} (${key||"global"}): no rule`);
  }

  /* de-dupe belief updates by key (last write wins; re-affirm + guard on same key → merge is not needed here) */
  const byKey = {}; for(const u of updates) byKey[u.key] = u;

  return {
    updates: Object.values(byKey),
    resolvedEventIds: [...resolved],
    escalateEventIds: [...escalate].filter(id => !resolved.has(id)),
    log
  };
}

module.exports = { autoDisposition, declaresCounterTrend };
