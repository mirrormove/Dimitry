/* ============================================================
   CONTRADICTION WATCHER      Vault Intelligence v4 · Step 4
   Zero dependencies.  PINNED — never hibernates.

   The only watcher that looks INWARD. It watches the belief store,
   not the market, which is what makes the system self-aware: it can
   notice that its own conclusions no longer hang together.

   THE LINE (spec §3): it emits FACTS ABOUT THE STORE.
     "these two beliefs disagree"        ← a fact, allowed
     "therefore the bias should be bear" ← reasoning, forbidden
   It never re-reads the market and never proposes a replacement.

   Emits
     BELIEF_ORPHANED   a setup whose parent bias has been invalidated
     BELIEF_CONFLICT   a setup pointing the opposite way to its own bias
     BELIEF_DECAYED    past one half-life (from BeliefStore.sweep)
     BELIEF_UNGUARDED  a directional belief with no invalidator at all
   ============================================================ */
"use strict";

const ID = "contradiction";
let SEQ = 0;
const mk = (o) => Object.assign({
  id: "con_" + String(++SEQ).padStart(6,"0"),
  watcher: ID, status: "new",              // belief-derived: authorised, not shadow
  confirm: { basis: "belief-store" },
  links: { confirms:[], contradicts:[], coOccurs:[] },
  claimedBy: null, processedAt: null, resultBeliefIds: []
}, o);

/* Direction stated by a belief, from its own words. Deliberately conservative:
   returns null unless the text is unambiguous, because a wrong conflict claim
   is worse than a missed one. */
function statedDirection(b){
  const v = String(b.value || "").toLowerCase();
  /* EXPLICIT NO-CLAIM: a 50/50, an inflection, a coin-flip or a range states NO direction,
     even when it mentions "bull structure" or "bear structure" in passing. Reading a side
     out of it manufactures a false conflict (e.g. a legit counter-trend fade vs a 50/50
     bias) — and a wrong conflict is worse than a missed one. Guard before the token scan. */
  if(/\b50\s*[\/\-\s]\s*50\b|coin[\s-]?flip|inflection|no directional edge|no direction|range[- ]?bound|\bno edge\b/.test(v)) return null;
  const longish  = /\blong\b|\bbuy\b|\bbull/.test(v);
  const shortish = /\bshort\b|\bsell\b|\bbear/.test(v);
  if(longish && shortish){
    /* "52 bull / 48 bear" — a probability split, not a direction claim.
       Take the side with the larger number, or null if they are equal. */
    const m = v.match(/(\d+)\s*(?:bull|long)[^\d]*(\d+)\s*(?:bear|short)/)
           || v.match(/(\d+)\s*\/\s*(\d+)/);
    if(m){ const a=+m[1], b2=+m[2]; return a===b2 ? null : (a>b2 ? "long" : "short"); }
    return null;
  }
  if(longish)  return "long";
  if(shortish) return "short";
  return null;
}

/** the bias belief that a setup belief depends on, if present */
function parentBias(all, b){
  if(!b.asset) return null;
  return all.find(x => x.asset === b.asset && /\.bias$/.test(x.key)) || null;
}

/**
 * @param {BeliefStore} store
 * @param {object} opts {now}
 * @returns {{events:Array, checked:number}}
 */
function run(store, opts){
  opts = opts || {};
  const now = opts.now || Date.now();
  const all = store.all(null, now).filter(b => b.class !== "doctrine");
  const events = [];

  /* ---- 1 · decayed beliefs (reuse the store's own sweep) ---- */
  for(const e of store.sweep(now)) events.push(mk(Object.assign({}, e, { watcher: ID })));

  const setups = all.filter(b => b.class === "opportunity");

  for(const s of setups){
    const bias = parentBias(all, s);

    /* ---- 2 · ORPHANED: the bias this setup rests on is dead ---- */
    if(bias && bias.status === "invalidated"){
      events.push(mk({
        t: now, asset: s.asset, type: "BELIEF_ORPHANED", tier: 4,
        fact: `"${s.claim}" still stands, but the bias it rests on ("${bias.claim}") was invalidated `
            + `${((now - bias.setAt)/3.6e6).toFixed(1)}h ago — the setup is orphaned`,
        evidence: { setup: s.key, bias: bias.key, biasInvalidatedAt: bias.setAt,
                    setupValue: String(s.value).slice(0,140) },
        affects: [s.key, bias.key], confidence: 0.9
      }));
      continue;                              // orphaned supersedes a direction check
    }

    /* ---- 3 · CONFLICT: the setup points against its own bias ---- */
    const sd = statedDirection(s), bd = bias ? statedDirection(bias) : null;
    if(sd && bd && sd !== bd){
      /* A setup that DECLARES itself a deliberate counter-trend / counter-momentum play
         is acknowledged by authorship — opposing its bias is the whole point, not an
         unreconciled contradiction. Without this it re-fires every cycle and piles up
         (K44). A genuinely ACCIDENTAL opposition carries no such declaration and is still
         surfaced below. */
      if(/counter-?trend|counter-?momentum|by design/i.test(String(s.value))) continue;
      /* NOT automatically an error — the vault runs deliberate counter-trend
         setups (the 07-26 gold golden-zone long against a bear 1D was correct).
         So this is raised as a FACT to be reconciled, never as a verdict. */
      events.push(mk({
        t: now, asset: s.asset, type: "BELIEF_CONFLICT", tier: 3,
        fact: `"${s.claim}" is ${sd.toUpperCase()} while "${bias.claim}" reads ${bd.toUpperCase()} `
            + `— counter-trend by design, or an unreconciled contradiction?`,
        evidence: { setup: s.key, setupDir: sd, bias: bias.key, biasDir: bd,
                    setupValue: String(s.value).slice(0,140), biasValue: String(bias.value).slice(0,140),
                    note: "deliberate counter-trend setups are legitimate — this needs reconciling, not obeying" },
        affects: [s.key, bias.key], confidence: 0.6
      }));
    }
  }

  /* ---- 4 · UNGUARDED: a directional belief with no stated invalidator ----
     Doctrine rule 1 is falsifiability. A directional claim with no condition
     that would prove it wrong cannot be checked by anything, ever. */
  for(const b of all){
    if(b.invalidator) continue;
    if(b.status === "invalidated") continue;
    if(b.uncommitted) continue;                       // never claimed a side
    if(!["structure","opportunity","macro"].includes(b.class)) continue;
    if(!statedDirection(b)) continue;
    events.push(mk({
      t: now, asset: b.asset, type: "BELIEF_UNGUARDED", tier: 2,
      fact: `"${b.claim}" states a direction but carries NO invalidator — nothing can prove it wrong`,
      evidence: { key: b.key, value: String(b.value).slice(0,140), class: b.class,
                  doctrine: "falsifiability: every directional claim needs a level, a direction and a horizon" },
      affects: [b.key], confidence: 0.85
    }));
  }

  return { events, checked: all.length, setups: setups.length };
}

function summarise(res){
  const by = {};
  res.events.forEach(e => by[e.type] = (by[e.type]||0)+1);
  const parts = Object.entries(by).map(([k,v]) => `${k} ${v}`);
  return `${res.checked} beliefs (${res.setups} setups) · `
       + (parts.length ? parts.join(" · ") : "no contradictions");
}

module.exports = { run, summarise, statedDirection, id: ID, PINNED: true };
