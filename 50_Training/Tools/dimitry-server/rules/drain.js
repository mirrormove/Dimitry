/* ============================================================
   BRAIN 3 DRAIN              Vault Intelligence v4 · Step 7
   Zero dependencies.

   Closes the loop: event → reasoning → belief.

   WHAT THIS IS NOT: it does not reason. Per the v3 structural rule,
   deterministic JavaScript cannot re-derive a market view. What the
   drain does is the two things AROUND the reasoning:

     PREPARE   claim the queue, coalesce by asset, and assemble a brief
               containing ONLY the affected beliefs plus doctrine —
               not the whole vault.
     RECORD    take the agent's conclusions and commit them as new
               beliefs (setBy:"agent"), marking the events processed.

   The reasoning itself happens in the agent layer. This file is the
   contract between the two, and it is deliberately transport-agnostic
   (spec §12): a scheduled agent run and an API worker use exactly the
   same claim/brief/apply protocol. Only latency differs.
   ============================================================ */
"use strict";

/* T4 (our own belief is inconsistent) outranks T3 (outside shock)
   outranks T2 (structure moved). Within a tier, oldest first — a
   contradiction that has been standing for a day is worse than a
   fresh one. */
const TIER_RANK = { 4: 0, 3: 1, 2: 2 };

/**
 * Claim work from the log and assemble the reasoning brief.
 * @param {EventLog}    log
 * @param {BeliefStore} store
 * @param {object} opts {max, by, now, dryRun}
 */
function claim(log, store, opts){
  opts = opts || {};
  const now = opts.now || Date.now();
  const max = opts.max || 25;
  const by  = opts.by  || "drain";

  const queue = log.claimable()
    .sort((a,b) => (TIER_RANK[a.tier] ?? 9) - (TIER_RANK[b.tier] ?? 9) || a.t - b.t)
    .slice(0, max);

  if(!queue.length) return { empty:true, claimed:[], briefs:[], summary:"queue empty — nothing to reason about" };

  /* COALESCE. One reasoning pass per ASSET, never one per event: ten events on
     BTC are one situation, not ten. This is what keeps the cost sane and stops
     the agent re-deriving the same view ten times. */
  const groups = {};
  for(const e of queue){
    const k = e.asset || "__global";
    (groups[k] = groups[k] || []).push(e);
  }

  if(!opts.dryRun) log.claim(queue.map(e => e.id), by);

  const doctrine = store.all({ class:"doctrine" }, now);
  const briefs = Object.entries(groups).map(([asset, events]) => {
    /* ONLY the beliefs these events actually touch, plus doctrine. */
    const keys = [...new Set(events.flatMap(e => e.affects || []))];
    const beliefs = keys.map(k => store.get(k, now)).filter(Boolean);
    /* plus any belief on this asset already flagged as awaiting reasoning (K13) */
    const awaiting = store.all({ asset: asset === "__global" ? undefined : asset }, now)
      .filter(b => b.awaitingReasoning && !keys.includes(b.key));

    return {
      asset,
      events: events.map(e => ({ id:e.id, type:e.type, tier:e.tier, t:e.t,
                                 fact:e.fact, evidence:e.evidence, affects:e.affects })),
      beliefs: beliefs.concat(awaiting).map(b => ({
        key:b.key, claim:b.claim, value:b.value,
        confidenceSet:b.confidence, confidenceNow:+b.confidenceNow.toFixed(3),
        ageH:+b.ageH.toFixed(1), status:b.status || "active",
        awaitingReasoning: !!b.awaitingReasoning,
        demoted:b.demoted, uncommitted:b.uncommitted,
        invalidator:b.invalidator, setBy:b.setBy
      })),
      doctrine: doctrine.map(d => ({ key:d.key, claim:d.claim, value:d.value })),
      /* what the agent must answer — stated explicitly so a cold session
         cannot mistake the task */
      asked: buildQuestions(events, beliefs.concat(awaiting))
    };
  });

  return { empty:false, claimed:queue.map(e=>e.id), briefs,
           summary:`claimed ${queue.length} events → ${briefs.length} reasoning pass${briefs.length===1?"":"es"} `
                 + `(${Object.keys(groups).join(", ")})` };
}

/** The explicit question each event type puts to the agent. */
function buildQuestions(events, beliefs){
  const q = [];
  const has = (t) => events.some(e => e.type === t);
  if(has("INVALIDATOR_FIRED"))
    q.push("A belief's own stated invalidator fired. The rule engine marked it dead but did NOT replace it — that is your job. What replaces it, and what is the new invalidator?");
  if(has("BELIEF_ORPHANED"))
    q.push("A setup is still standing while the bias it rested on is dead. Does the setup survive on its own evidence, or does it go with the bias?");
  if(has("BELIEF_CONFLICT"))
    q.push("A setup points against its own bias. Is this a deliberate counter-trend trade (legitimate — the record has winners) or an unreconciled contradiction?");
  if(has("BELIEF_DECAYED"))
    q.push("A belief has lost half its original claim to time. Re-affirm it with fresh evidence, revise it, or retire it.");
  if(has("BELIEF_UNGUARDED"))
    q.push("A directional belief has no invalidator. State the level, direction and horizon that would prove it wrong.");
  if(has("EV_DEGRADED"))
    q.push("A setup no longer clears the bar. Re-price it or take it off the book.");
  if(has("BOS_CONFIRMED") || has("CHOCH_CONFIRMED") || has("LEVEL_BREAK"))
    q.push("Structure moved. Does the bias change, or was this already inside the thesis?");
  if(beliefs.some(b => b.uncommitted))
    q.push("At least one belief is uncommitted (a genuine 50/50). Is there now enough evidence to take a side, or does it stay honest?");
  return q;
}

/**
 * RECORD the agent's conclusions.
 * @param {Array} updates  [{key, claim, value, confidence, class, asset, invalidator, evidence, prior}]
 * @param {Array} eventIds events these conclusions resolve
 */
function apply(log, store, updates, eventIds, opts){
  opts = opts || {};
  const now = opts.now || Date.now();
  const written = [];

  for(const u of updates || []){
    if(!u.key || !u.class) throw new Error("a belief update needs at least {key, class}: "+JSON.stringify(u).slice(0,90));
    const prev = store.get(u.key, now);
    const rec = store.set({
      key:u.key,
      claim: u.claim || (prev && prev.claim) || u.key,
      value: u.value,
      confidence: u.confidence,
      prior: u.prior != null ? u.prior : (prev ? prev.prior : 0.5),
      class: u.class,
      asset: u.asset || (prev && prev.asset) || null,
      invalidator: u.invalidator || null,
      evidence: u.evidence || [],
      setBy: "agent",                       // the agent reasoned — not a rule, not a watcher
      setAt: now,
      source: u.source || null
    });
    /* the belief is alive again: whatever was awaiting reasoning has been answered */
    rec.status = "active";
    rec.awaitingReasoning = false;
    written.push({ key:rec.key, uid:rec.uid,
                   was: prev ? prev.value : null, now: rec.value,
                   confidence: `${prev?Math.round(prev.confidenceNow*100):"—"}% → ${Math.round((u.confidence??0.5)*100)}%` });
  }

  /* idempotent by construction — EventLog.process() no-ops on an already
     processed event, so re-running a drain is safe */
  const processed = [];
  for(const id of eventIds || []){
    const r = log.process(id, written.map(w => w.uid));
    if(r) processed.push(id);
  }

  if(written.length) store.save();
  return { written, processed,
           summary:`${written.length} belief${written.length===1?"":"s"} written by the agent · `
                 + `${processed.length} event${processed.length===1?"":"s"} marked processed` };
}

/** Human-readable brief — what a scheduled agent run actually reads. */
function briefMarkdown(claimResult){
  if(claimResult.empty) return "# Drain — queue empty\n\nNothing to reason about.\n";
  let m = `# Reasoning brief — ${claimResult.briefs.length} pass(es)\n\n`;
  m += `> ${claimResult.summary}\n>\n`;
  m += `> **The rule engine and the watchers have done the bookkeeping. What follows needs judgement.**\n`;
  m += `> Reply by calling \`apply()\` with belief updates — value, confidence, and a NEW invalidator for each.\n\n`;
  for(const b of claimResult.briefs){
    m += `---\n\n## ${b.asset}\n\n### What fired\n\n`;
    for(const e of b.events) m += `- **[T${e.tier} ${e.type}]** ${e.fact}\n`;
    m += `\n### Beliefs in play\n\n| Belief | Value | Set | Now | Age | State |\n|---|---|---|---|---|---|\n`;
    for(const x of b.beliefs){
      const st = x.status==="invalidated" ? "**DEAD**" : x.awaitingReasoning ? "awaiting" :
                 x.demoted ? "decayed" : x.uncommitted ? "uncommitted" : "active";
      m += `| \`${x.key}\` | ${String(x.value).slice(0,60)} | ${Math.round(x.confidenceSet*100)}% | ${Math.round(x.confidenceNow*100)}% | ${x.ageH}h | ${st} |\n`;
    }
    if(b.asked.length){
      m += `\n### What you must answer\n\n`;
      b.asked.forEach((q,i) => m += `${i+1}. ${q}\n`);
    }
    m += `\n### Doctrine in force\n\n`;
    m += b.doctrine.map(d => `- ${d.claim}: **${d.value}**`).join("\n") + "\n\n";
  }
  return m;
}

module.exports = { claim, apply, briefMarkdown, buildQuestions, TIER_RANK };
