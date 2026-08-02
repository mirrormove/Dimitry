/* ============================================================
   WATCH MANAGER      Vault Intelligence v4 · Step 6
   Zero dependencies.

   Attention is scarce. Watching every asset at full depth every cycle is both
   wasteful and its own noise. The Watch Manager allocates a bounded ATTENTION
   BUDGET to where watching pays — by Expected Information Gain — and puts the
   rest to sleep behind a cheap TRIPWIRE.

   EIG per target ≈  importance × uncertainty × session × precision ÷ cost
     importance   an armed, directional setup > a decayed belief > a bare bias
     uncertainty  how much could change (awaiting-reasoning / decayed / near a level)
     session      is this the asset's active session right now?
     precision    how measurable our signal is here (crypto measured; FX thin — K9/K29)
     cost         intraday feeds cost more attention than a daily one

   Tiers:  ACTIVE     full watch (spends budget)
           LIGHT      tripwire only — cheap wake condition armed
           HIBERNATE  asleep, but STILL tripwired if a belief invalidator could fire
                      (safety floor: never stop watching what could prove you wrong)

   Auditable: `allocate()` returns the full plan with per-target reasons, for the
   dashboard. `run()` diffs against the prior plan and emits ATTENTION_SHIFT
   (woke / hibernated) + PROPOSE_ATTENTION (a surprise worth a human's review).
   ============================================================ */
"use strict";
const { statedDirection } = require("./contradiction.js");

const ID = "watch-manager";
let SEQ = 0;
const mk = (o) => Object.assign({
  id:"wm_"+String(++SEQ).padStart(6,"0"), watcher:ID, status:"new",
  confirm:{ basis:"belief-store" }, links:{confirms:[],contradicts:[],coOccurs:[]},
  claimedBy:null, processedAt:null, resultBeliefIds:[]
}, o);

/* per-asset data confidence (precision proxy) — honest about where the data is thin */
const DATA_CONF = { BTCUSDT:1.0, EURUSD:0.7, XAUUSD:0.65, GBPUSD:0.5, USDJPY:0.5 };
const COST      = { BTCUSDT:1.0, EURUSD:1.0, XAUUSD:0.6, GBPUSD:0.6, USDJPY:0.6 };  // intraday vs daily
const isCrypto  = a => a==="BTCUSDT" || /USDT$/.test(a||"") || /^(BTC|ETH)/.test(a||"");
/* Is this asset's market OPEN now? Crypto is 24/7; FX & metals close on the
   weekend (Fri 21:00Z → Sun 21:00Z). A closed market gets no attention — energy
   is conserved for where the tape can actually move. */
function marketOpen(asset, now){
  if(isCrypto(asset)) return true;
  const d=new Date(now||Date.now()), day=d.getUTCDay(), h=d.getUTCHours();
  return !(day===6 || (day===0 && h<21) || (day===5 && h>=21));
}

/** 0.5–1.0 — is now this asset's active session? */
function sessionWeight(asset, now){
  if(isCrypto(asset)) return 1.0;                          // 24/7
  const h = new Date(now).getUTCHours();
  const london = h>=7 && h<16, ny = h>=12 && h<21, tokyo = h>=0 && h<9;
  if(asset==="USDJPY") return tokyo ? 1.0 : (ny?0.7:0.55);
  if(asset==="XAUUSD") return (london||ny) ? 1.0 : 0.7;
  return london ? 1.0 : ny ? 0.9 : 0.5;                   // EUR/GBP
}

/** score one asset. pass opts.prices[asset] to factor distance-to-zone into uncertainty. */
function attentionScore(store, asset, opts){
  const now = opts.now || Date.now();
  const beliefs = store.all({ asset }, now).filter(b => b.status !== "invalidated");
  const setup = beliefs.find(b => /\.primarySetup$/.test(b.key));
  const factors = [];

  let importance = 0.3;
  if(setup){
    const retired = /RETIRED|no trade/i.test(String(setup.value));
    const dir = statedDirection(setup);
    importance = retired ? 0.2 : dir ? 1.0 : 0.5;
    factors.push(retired ? "setup retired" : dir ? "armed directional setup" : "setup, no side");
  } else if(beliefs.some(b=>/\.bias$/.test(b.key))){ importance = 0.4; factors.push("bias only"); }

  // uncertainty: how much could move — awaiting / decayed / uncommitted, plus near-zone if price given
  const flagged = beliefs.filter(b => b.awaitingReasoning || b.demoted || b.uncommitted).length;
  let uncertainty = beliefs.length ? Math.min(1, 0.3 + 0.5*(flagged/beliefs.length)) : 0.3;
  if(flagged) factors.push(`${flagged} belief(s) need a look`);
  const px = opts.prices && opts.prices[asset];
  if(px != null && setup && setup.value){
    const m = String(setup.value).match(/(\d[\d,]*)\s*[–-]\s*(\d[\d,]*)/);
    if(m){ const lo=+m[1].replace(/,/g,""), hi=+m[2].replace(/,/g,""); const mid=(lo+hi)/2;
      const distPct = Math.abs(px-mid)/mid*100;
      if(distPct < 1){ uncertainty = Math.min(1, uncertainty+0.4); factors.push(`price ${distPct.toFixed(2)}% from the zone`); } }
  }

  const session   = sessionWeight(asset, now);
  const precision = DATA_CONF[asset] != null ? DATA_CONF[asset] : 0.6;
  const cost      = COST[asset] != null ? COST[asset] : 0.8;
  // safety: any live invalidator that could fire keeps this asset at least tripwired
  const guarded = beliefs.filter(b => b.invalidator);
  const guardRisk = guarded.length > 0;

  const closed = !marketOpen(asset, now);
  const eig = closed ? 0 : +((importance * (0.5 + 0.5*uncertainty) * session * precision) / cost).toFixed(3);
  const retired = importance <= 0.25;                       // setup retired / stood down
  return { asset, eig, closed, importance:+importance.toFixed(2), retired, uncertainty:+uncertainty.toFixed(2),
           session:+session.toFixed(2), precision, cost, guardRisk,
           tripwire: guardRisk ? tripwireFrom(guarded) : (setup ? tripwireFrom([setup]) : null),
           factors };
}

/** cheapest wake condition — a price level from an invalidator or a setup zone. */
function tripwireFrom(beliefs){
  for(const b of beliefs){
    const src = b.invalidator || String(b.value||"");
    const m = String(src).match(/(\d[\d,]*(?:\.\d+)?)/);
    if(m) return { key:b.key, level:+m[1].replace(/,/g,""), from:(b.invalidator?"invalidator":"zone"), wakesTo:"ACTIVE" };
  }
  return null;
}

/** allocate the attention budget → an auditable plan. */
function allocate(store, opts){
  opts = opts || {};
  const budget = opts.budget != null ? opts.budget : 2.6;    // cost-units of ACTIVE attention
  const assets = [...new Set(store.all(null, opts.now||Date.now()).map(b=>b.asset).filter(Boolean))];
  const scored = assets.map(a => attentionScore(store, a, opts)).sort((x,y)=>y.eig - x.eig);

  let spent = 0;
  const plan = scored.map(s => {
    let tier;
    if(s.closed) tier = "HIBERNATE";                          // market closed → no attention spent
    else if(spent + s.cost <= budget && s.eig > 0.15){ tier = "ACTIVE"; spent += s.cost; }
    else if(s.guardRisk || s.eig > 0.08) tier = "LIGHT";       // tripwire armed
    else tier = "HIBERNATE";
    const why = s.closed ? "market closed — energy conserved"
              : tier==="ACTIVE" ? `EIG ${s.eig} — ${s.factors.slice(0,2).join(", ")||"in budget"}`
              : tier==="LIGHT"  ? `below budget; tripwire armed${s.guardRisk?" (invalidator live)":""}`
              : "quiet — asleep";
    return { asset:s.asset, tier, eig:s.eig, cost:s.cost, closed:s.closed, tripwire:s.tripwire, guardRisk:s.guardRisk, retired:s.retired, why, factors:s.factors };
  });
  return { budget, spent:+spent.toFixed(2), active:plan.filter(p=>p.tier==="ACTIVE").length,
           light:plan.filter(p=>p.tier==="LIGHT").length, hibernate:plan.filter(p=>p.tier==="HIBERNATE").length,
           targets:plan };
}

/** diff against a prior plan and emit shifts + proposals. */
function run(store, opts){
  opts = opts || {};
  const now = opts.now || Date.now();
  const plan = allocate(store, opts);
  const prior = (opts.prior && opts.prior.targets) || [];
  const priorTier = Object.fromEntries(prior.map(p=>[p.asset, p.tier]));
  const events = [];

  for(const t of plan.targets){
    const was = priorTier[t.asset];
    if(was && was !== t.tier){
      const woke = ["ACTIVE","LIGHT"].indexOf(t.tier) < ["ACTIVE","LIGHT","HIBERNATE"].indexOf(was);
      events.push(mk({ t:now, asset:t.asset, type:"ATTENTION_SHIFT", tier:1,
        fact:`${t.asset}: ${was} → ${t.tier}${woke?" (woke)":" (hibernated)"} — ${t.why}`,
        evidence:{ asset:t.asset, from:was, to:t.tier, eig:t.eig, tripwire:t.tripwire }, affects:[] }));
    }
  }
  /* PROPOSE (review required): a low-attention asset (LIGHT/HIBERNATE) whose setup is RETIRED
     yet still carries a LIVE invalidator — a stale guard. Promote it, or retire the belief? */
  for(const t of plan.targets){
    if(t.tier!=="ACTIVE" && t.guardRisk && t.retired)
      events.push(mk({ t:now, asset:t.asset, type:"PROPOSE_ATTENTION", tier:2,
        fact:`${t.asset} is ${t.tier.toLowerCase()} with a RETIRED setup but a still-live invalidator — promote it, or retire the stale guard? (review)`,
        evidence:{ asset:t.asset, tier:t.tier, tripwire:t.tripwire }, affects:[], confidence:0.6 }));
  }
  return { plan, events };
}

function summarise(res){
  const p = res.plan || res;
  return `attention: ${p.active} active · ${p.light} light · ${p.hibernate} hibernate (budget ${p.spent}/${p.budget}) → `
       + p.targets.map(t=>`${t.asset}:${t.tier[0]}`).join(" ");
}

module.exports = { allocate, run, attentionScore, sessionWeight, tripwireFrom, summarise, id:ID, PINNED:true };
