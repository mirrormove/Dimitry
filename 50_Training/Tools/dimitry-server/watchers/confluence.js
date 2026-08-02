/* ============================================================
   CORRELATION / CONFLUENCE ENGINE   Vault Intelligence v4 · Step 5
   Zero dependencies. PINNED.

   Combines the vault's independent LENSES into one composite read — and its
   whole reason to exist is a single honesty rule:

     DO NOT MISTAKE THE VAULT AGREEING WITH ITSELF FOR CONFIRMATION.

   A primary setup is DERIVED FROM its bias; the two agreeing is internal
   consistency, not confluence. Real confluence is DIFFERENT information
   sources — structure, macro, flow, sentiment, cross-asset — pointing the same
   way. So signals are grouped by lens, within-lens signals COLLAPSE to one
   vote, and only ALIGNED INDEPENDENT LENSES raise conviction.

   THREE HONESTY GATES on the measured co-occurrence matrix (which refines the
   a-priori lens independence):
     1 · MEASURED — correlation comes from observed co-occurrence, never assumed.
     2 · SAMPLE   — a pair is only trusted at n ≥ MIN_PAIR; else lenses stay
                    independent-by-construction (conservative for a claim of
                    correlation, honest about the gap).
     3 · LIFT     — co-occurrence must beat the chance baseline (lift > bar) to
                    be called correlated; ~1 is independent, < bar is nothing.

   Emits  CONFLUENCE  ≥2 independent lenses aligned, none opposing (higher conviction)
          DIVERGENCE  independent lenses point opposite ways (lower conviction / a question)
   ============================================================ */
"use strict";
const { statedDirection } = require("./contradiction.js");
const { dollarCryptoSign } = require("./macro.js");

const ID = "confluence";
const MIN_PAIR = 8;        // gate 2 — co-occurrences before a correlation is trusted
const LIFT_BAR = 1.3;      // gate 3 — lift over chance to call a pair "correlated"
let SEQ = 0;
const mk = (o) => Object.assign({
  id: "cfl_" + String(++SEQ).padStart(6,"0"),
  watcher: ID, status: "new", confirm: { basis: "belief-store" },
  links: { confirms:[], contradicts:[], coOccurs:[] },
  claimedBy: null, processedAt: null, resultBeliefIds: []
}, o);

/* which independent information source a belief belongs to. A setup and the bias
   it rests on share a lens on purpose — they are NOT independent evidence. */
function lensOf(b){
  const k = b.key || "";
  if(/\.bias$|\.structure|\.primarySetup$|\.keyZone$|\.mustHold$/.test(k)) return "structure";
  if(b.class === "macro" || /^macro\./.test(k))       return "macro";
  if(b.class === "correlation" || /^correlation\./.test(k)) return "correlation";
  if(b.class === "flow" || /\.flow\./.test(k))        return "flow";
  if(b.class === "sentiment" || /sentiment/.test(k))  return "sentiment";
  return "other";
}
const isCrypto = a => a === "BTCUSDT" || /USDT$/.test(a||"") || /^(BTC|ETH)/.test(a||"");

/** Directional signals for one asset, tagged by lens. dir: +1 up / −1 down. */
function signalsForAsset(store, asset, now){
  const sig = [];
  for(const b of store.all({ asset }, now)){
    if(b.status === "invalidated") continue;
    const d = statedDirection(b);
    if(!d) continue;
    sig.push({ key:b.key, lens:lensOf(b), dir:d==="long"?1:-1, weight:+ (b.confidenceNow||0.5).toFixed(3) });
  }
  /* the macro regime is an INDEPENDENT lens for crypto (dollar leads it inversely) */
  if(isCrypto(asset)){
    const dollar = store.all({ class:"macro" }, now).find(b => b.key === "macro.dollar");
    if(dollar){ const s = dollarCryptoSign(dollar.value);
      if(s) sig.push({ key:"macro.dollar", lens:"macro", dir:s, weight:+(dollar.confidenceNow||0.6).toFixed(3) }); }
  }
  return sig;
}

/* ---- the measured co-occurrence matrix (refinement, honestly gated) ---- */
function buildMatrix(events, opts){
  opts = opts || {};
  const winMs = opts.windowMs || 6*36e5;          // co-occurrence window
  const withKey = events.filter(e => (e.affects||[]).length && Number.isFinite(e.t))
    .map(e => ({ t:e.t, keys:e.affects }));
  const count = {}, pair = {};
  for(const e of withKey) for(const k of e.keys) count[k] = (count[k]||0)+1;
  const N = withKey.length || 1;
  for(let i=0;i<withKey.length;i++){
    for(let j=i+1;j<withKey.length;j++){
      if(Math.abs(withKey[i].t - withKey[j].t) > winMs) continue;
      for(const a of withKey[i].keys) for(const b of withKey[j].keys){
        if(a===b) continue; const pk = [a,b].sort().join("|");
        pair[pk] = (pair[pk]||0)+1;
      }
    }
  }
  const matrix = {};
  for(const [pk,co] of Object.entries(pair)){
    const [a,b] = pk.split("|");
    const expected = (count[a]*count[b]) / N;                 // chance baseline
    const lift = expected > 0 ? co/expected : 0;
    const gate = co < MIN_PAIR ? "insufficient" : lift >= LIFT_BAR ? "correlated" : lift <= (1/LIFT_BAR) ? "anti" : "independent";
    matrix[pk] = { n:co, lift:+lift.toFixed(2), gate };
  }
  return matrix;
}

/** Collapse signals to independent-lens votes, then score confluence. */
function confluence(signals, matrix){
  matrix = matrix || {};
  /* 1 · within-lens collapse — same lens = one vote (weighted net direction) */
  const lenses = {};
  for(const s of signals){
    const L = lenses[s.lens] = lenses[s.lens] || { lens:s.lens, sum:0, wsum:0, keys:[] };
    L.sum += s.dir * s.weight; L.wsum += s.weight; L.keys.push(s.key);
  }
  let votes = Object.values(lenses)
    .map(L => ({ lens:L.lens, dir: L.sum>0?1:L.sum<0?-1:0, weight:+(Math.abs(L.sum)).toFixed(3), keys:L.keys }))
    .filter(v => v.dir !== 0);

  /* 2 · matrix merge — if two lenses are MEASURED-correlated, they are not two
        independent votes; keep the stronger, drop the other (gate-guarded). */
  const merged = new Set();
  for(let i=0;i<votes.length;i++) for(let j=i+1;j<votes.length;j++){
    if(merged.has(votes[j].lens) || merged.has(votes[i].lens)) continue;
    const corr = Object.entries(matrix).some(([pk,m]) => m.gate==="correlated" &&
      pk.split("|").some(k=>votes[i].keys.includes(k)) && pk.split("|").some(k=>votes[j].keys.includes(k)));
    if(corr){ const weaker = votes[i].weight>=votes[j].weight ? votes[j] : votes[i]; merged.add(weaker.lens); }
  }
  votes = votes.filter(v => !merged.has(v.lens));

  /* 3 · score across INDEPENDENT lenses */
  const up = votes.filter(v=>v.dir>0), dn = votes.filter(v=>v.dir<0);
  const netDir = up.length===dn.length ? (up.reduce((a,v)=>a+v.weight,0) >= dn.reduce((a,v)=>a+v.weight,0) ? 1 : -1)
               : up.length>dn.length ? 1 : -1;
  const aligned = (netDir>0?up:dn), opposing = (netDir>0?dn:up);
  const verdict = votes.length<2 ? "THIN"
                : opposing.length===0 ? "CONFLUENCE"
                : "DIVERGENCE";
  const score = +(aligned.reduce((a,v)=>a+v.weight,0) - opposing.reduce((a,v)=>a+v.weight,0)).toFixed(3);
  return { verdict, netDir, independentLenses:votes.length, aligned, opposing,
           mergedOut:[...merged], score, lenses:votes };
}

function run(store, opts){
  opts = opts || {};
  const now = opts.now || Date.now();
  const matrix = opts.matrix || (opts.events ? buildMatrix(opts.events, opts) : {});
  const assets = [...new Set(store.all(null, now).map(b=>b.asset).filter(Boolean))];
  const events = [], reads = [];
  for(const asset of assets){
    const sig = signalsForAsset(store, asset, now);
    if(sig.length < 2) continue;
    const c = confluence(sig, matrix);
    reads.push({ asset, ...c });
    if(c.verdict === "CONFLUENCE"){
      events.push(mk({ t:now, asset, type:"CONFLUENCE", tier:2,
        fact:`${asset}: ${c.independentLenses} independent lenses agree ${c.netDir>0?"LONG":"SHORT"} `
           + `(${c.aligned.map(v=>v.lens).join(" + ")}) — composite conviction, not internal echo.`,
        evidence:{ asset, netDir:c.netDir, lenses:c.aligned, mergedOut:c.mergedOut, score:c.score },
        affects:c.aligned.flatMap(v=>v.keys), confidence:Math.min(0.9, 0.5+0.15*c.independentLenses) }));
    } else if(c.verdict === "DIVERGENCE"){
      events.push(mk({ t:now, asset, type:"DIVERGENCE", tier:2,
        fact:`${asset}: lenses DISAGREE — ${c.aligned.map(v=>v.lens).join("/")} ${c.netDir>0?"long":"short"} vs `
           + `${c.opposing.map(v=>v.lens).join("/")} ${c.netDir>0?"short":"long"}. Lower the conviction; reconcile before sizing.`,
        evidence:{ asset, aligned:c.aligned, opposing:c.opposing, score:c.score },
        affects:c.lenses.flatMap(v=>v.keys), confidence:0.6 }));
    }
  }
  return { events, reads, assets:assets.length, matrixPairs:Object.keys(matrix).length };
}

function summarise(res){
  const by = {}; res.events.forEach(e => by[e.type]=(by[e.type]||0)+1);
  return `${res.assets} assets · matrix ${res.matrixPairs} pairs · `
       + (Object.keys(by).length ? Object.entries(by).map(([k,v])=>`${k} ${v}`).join(" · ") : "no composite signal");
}

module.exports = { run, summarise, confluence, buildMatrix, signalsForAsset, lensOf, id:ID, PINNED:true, MIN_PAIR, LIFT_BAR };
