/* ============================================================
   MACRO · REGIME · CALENDAR · CORRELATION WATCHER
   Vault Intelligence v4 · Step 4b       Zero dependencies. PINNED.

   The second inward watcher. Where Contradiction asks "do my beliefs hang
   together?", this one asks "does the MACRO BACKDROP still support them, and
   is a known event about to move the tape?" — using the macro.* / correlation.*
   beliefs the analysis already writes (the vault's feeds, captured as beliefs).

   THE LINE (spec §3, inherited): it emits FACTS, never verdicts.
     "a crypto long sits against a dollar-positive regime"   ← a fact, allowed
     "therefore close the long"                              ← reasoning, forbidden
   It never re-reads a live feed and never proposes a replacement.

   Emits
     REGIME_NOTE          the macro backdrop, as one surfaced fact (tier 1)
     NEWS_AHEAD           a dated high-impact event 12–72h out — heads-up (tier 2)
     NEWS_WINDOW          that event is now live (−12h..+6h) — scope execution (tier 3)
     REGIME_CONFLICT      a directional setup/bias fighting the macro regime (tier 3)
     CORRELATION_UNGUARDED a correlation claim with no condition that breaks it (tier 2)

   Feed-blocked and therefore NOT here (need a real feed, not detection):
     · live liquidity heatmap  (Coinglass)      → LIQUIDITY watcher, deferred
     · live sentiment F&G / funding             → SENTIMENT watcher, deferred
   Those stay dark rather than fabricated. See the 4b notes in the Build Ledger.
   ============================================================ */
"use strict";

const { statedDirection } = require("./contradiction.js");

const ID = "macro";
let SEQ = 0;
const mk = (o) => Object.assign({
  id: "mac_" + String(++SEQ).padStart(6,"0"),
  watcher: ID, status: "new",
  confirm: { basis: "belief-store" },
  links: { confirms:[], contradicts:[], coOccurs:[] },
  claimedBy: null, processedAt: null, resultBeliefIds: []
}, o);

const MONTHS = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };

/* Pull a calendar date out of an event belief's words. Returns a ms timestamp or
   null. Reference year is `now`'s year, rolled forward if the date already passed
   by more than a month (so a "Jan 3" written in December means next year). */
function eventDate(value, now){
  const v = String(value||"");
  let y, mo, d, hh=13, mm=0;                              // default midday if no clock given
  let m = v.match(/(\d{4})-(\d{2})-(\d{2})/);
  if(m){ y=+m[1]; mo=+m[2]-1; d=+m[3]; }
  else {
    m = v.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/i);
    if(!m) return null;
    mo = MONTHS[m[1].toLowerCase().slice(0,3)]; d = +m[2];
    y = new Date(now).getUTCFullYear();
  }
  const clk = v.match(/\b(\d{1,2}):(\d{2})\b/);
  if(clk){ hh=+clk[1]; mm=+clk[2]; }
  let t = Date.UTC(y, mo, d, hh, mm);
  if(t < now - 31*864e5) t = Date.UTC(y+1, mo, d, hh, mm);   // rolled past → next year
  return t;
}

/* Dollar regime → its risk sign for CRYPTO (dollar up = risk-off headwind).
   +1 = supports crypto longs, -1 = headwind for crypto longs, 0 = unclear. */
function dollarCryptoSign(value){
  const v = String(value||"").toLowerCase();
  const up   = /\b(dollar|usd|dxy)[- ]?(positive|strong|bull|up|bid)|dxy up|strong dollar/.test(v);
  const down = /\b(dollar|usd|dxy)[- ]?(negative|weak|bear|down|soft)|weak dollar/.test(v);
  if(up && !down) return -1;
  if(down && !up) return 1;
  return 0;
}

const isCrypto = (b) => b.asset === "BTCUSDT" || /USDT$/.test(b.asset||"") || /^(BTC|ETH)/.test(b.asset||"");

/**
 * @param {BeliefStore} store
 * @param {object} opts {now}
 * @returns {{events:Array, checked:number, regime:object}}
 */
function run(store, opts){
  opts = opts || {};
  const now = opts.now || Date.now();
  const all = store.all(null, now).filter(b => b.status !== "invalidated");
  const events = [];

  const dollar = all.find(b => b.key === "macro.dollar");
  const dSign  = dollar ? dollarCryptoSign(dollar.value) : 0;

  /* ---- 1 · REGIME_NOTE — the backdrop as one surfaced fact ---- */
  if(dollar){
    const lean = dSign < 0 ? "risk-OFF headwind for crypto longs"
               : dSign > 0 ? "risk-ON tailwind for crypto"
               : "no clear cross-asset lean";
    events.push(mk({
      t: now, asset: null, type: "REGIME_NOTE", tier: 1,
      fact: `Macro regime — ${String(dollar.value)} → ${lean}. (${(dollar.confidenceNow*100).toFixed(0)}% conf, ${dollar.ageH.toFixed(0)}h old)`,
      evidence: { key: dollar.key, value: String(dollar.value).slice(0,140), dollarCryptoSign: dSign,
                  correlation: (all.find(b=>b.class==="correlation")||{}).value || null },
      affects: [dollar.key], confidence: 0.6
    }));
  }

  /* ---- 2 · CALENDAR — dated high-impact events from macro.* beliefs ---- */
  for(const b of all){
    if(b.class !== "macro") continue;
    const t = eventDate(b.value, now);
    if(t == null) continue;
    const hoursUntil = (t - now) / 3.6e6;
    if(hoursUntil >= -6 && hoursUntil <= 12){
      events.push(mk({
        t: now, asset: b.asset || null, type: "NEWS_WINDOW", tier: 3,
        fact: `NEWS WINDOW LIVE — "${b.claim}" (${String(b.value).slice(0,60)}) is ${hoursUntil>=0?`in ${hoursUntil.toFixed(1)}h`:`${(-hoursUntil).toFixed(1)}h ago`}. Scope execution to WATCH-ONLY through the print.`,
        evidence: { key: b.key, eventAt: t, hoursUntil: +hoursUntil.toFixed(1), value: String(b.value).slice(0,140) },
        affects: [b.key], confidence: 0.9
      }));
    } else if(hoursUntil > 12 && hoursUntil <= 72){
      events.push(mk({
        t: now, asset: b.asset || null, type: "NEWS_AHEAD", tier: 2,
        fact: `Event ahead — "${b.claim}" (${String(b.value).slice(0,60)}) in ${hoursUntil.toFixed(0)}h. Plan around it; don't open size that can't survive the window.`,
        evidence: { key: b.key, eventAt: t, hoursUntil: +hoursUntil.toFixed(1), value: String(b.value).slice(0,140) },
        affects: [b.key], confidence: 0.85
      }));
    }
  }

  /* ---- 3 · REGIME_CONFLICT — a directional claim fighting the regime ----
     Conservative: crypto only (dollar is inverse to crypto with a proven lead),
     and only when the dollar states a clear side. A FACT to reconcile, never a verdict. */
  if(dSign !== 0){
    for(const b of all){
      if(!["opportunity","structure"].includes(b.class)) continue;
      if(!isCrypto(b)) continue;
      const dir = statedDirection(b);
      if(!dir) continue;
      const fights = (dSign < 0 && dir === "long") || (dSign > 0 && dir === "short");
      if(!fights) continue;
      const regimeTxt = dSign < 0 ? "dollar-positive (risk-off)" : "dollar-negative (risk-on)";
      events.push(mk({
        t: now, asset: b.asset, type: "REGIME_CONFLICT", tier: 3,
        fact: `"${b.claim}" is ${dir.toUpperCase()} while the macro regime is ${regimeTxt} — a cross-asset headwind, or a deliberate fade of it?`,
        evidence: { key: b.key, dir, dollar: dollar.key, dollarValue: String(dollar.value).slice(0,120),
                    dollarCryptoSign: dSign,
                    note: "the dollar leads crypto inversely (correlation.usdtd.btc) — this needs reconciling, not obeying" },
        affects: [b.key, dollar.key], confidence: 0.55
      }));
    }
  }

  /* ---- 4 · CORRELATION_UNGUARDED — a correlation claim that can't break ----
     Contradiction's falsifiability check covers structure/opportunity/macro but NOT
     the correlation class; a regime correlation can decouple, so it needs a condition. */
  for(const b of all){
    if(b.class !== "correlation") continue;
    if(b.invalidator) continue;
    events.push(mk({
      t: now, asset: b.asset || null, type: "CORRELATION_UNGUARDED", tier: 2,
      fact: `"${b.claim}" (${String(b.value).slice(0,50)}) carries NO invalidator — a correlation can decouple, so state what would prove it broken.`,
      evidence: { key: b.key, value: String(b.value).slice(0,140), class: b.class,
                  doctrine: "falsifiability: a correlation claim needs a decoupling condition" },
      affects: [b.key], confidence: 0.8
    }));
  }

  return { events, checked: all.length, regime: { dollarCryptoSign: dSign,
           dollar: dollar ? String(dollar.value).slice(0,80) : null } };
}

/* Is a high-impact event live right now? Lets the daemon pass newsWindow:true to
   the Opportunity watcher so the day's move is scoped WATCH-ONLY through a print. */
function newsWindowNow(store, now){
  now = now || Date.now();
  return store.all(null, now).some(b =>
    b.class === "macro" && b.status !== "invalidated" && (() => {
      const t = eventDate(b.value, now); if(t == null) return false;
      const h = (t - now)/3.6e6; return h >= -6 && h <= 12;
    })());
}

function summarise(res){
  const by = {};
  res.events.forEach(e => by[e.type] = (by[e.type]||0)+1);
  const parts = Object.entries(by).map(([k,v]) => `${k} ${v}`);
  const reg = res.regime.dollarCryptoSign;
  const regTxt = reg<0?"risk-off":reg>0?"risk-on":"neutral";
  return `${res.checked} beliefs · regime ${regTxt} · ` + (parts.length ? parts.join(" · ") : "nothing to flag");
}

module.exports = { run, summarise, newsWindowNow, eventDate, dollarCryptoSign, id: ID, PINNED: true };
