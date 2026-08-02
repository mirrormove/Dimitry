/* ============================================================
   OPPORTUNITY WATCHER        Vault Intelligence v4 · Step 4 · rev 2 (Move Capture)
   Zero dependencies.  PINNED — never hibernates.

   Answers: **what is the MOVE, and where can I act on it?**

   REV 2 (2026-07-28) rebuilt after a real miss: on 07-27 the system had the
   correct primary call (SHORT the OB Edge → Bull Line, a clean 3% move) and
   said "No trade" all day. See doctrine:
     30_Trading/Doctrine/Move Capture — Campaign R:R over Entry R:R.md

   The four principles it now enforces:
     1 · Score the CAMPAIGN (entry → FINAL target), not the entry point.
     2 · An armed setup's viability is STRUCTURAL (its invalidator), not TEMPORAL
         (decay flags "re-confirm", it never makes a setup un-actionable).
     3 · Account / news gates SCOPE execution (clear / prop-only / watch-only) —
         they do NOT hide the move.
     4 · The move is a WINDOW with entry windows: at-zone, and each pullback
         while running is a CONTINUATION window.

   THE LINE (spec §3): still emits FACTS about the book — the move, its R:R,
   its scope, its stage. It does NOT invent a setup or a direction.

   Emits (all TIER 1 — these SURFACE the state of the book for the operator /
   dashboard; they are not reasoning tasks for the agent, so they never clog the
   reasoning queue or the freshness indicator. The move persists, visibly, all day.)
     PRIMARY_MOVE         the best structurally-valid campaign — surfaced ALL day
     ENTRY_WINDOW         price is in the zone; the trigger is live
     CONTINUATION_WINDOW  the campaign is running and price pulled back to the anchor
     NO_TRADE             ONLY when no valid setup exists, or a terminal gate
   ============================================================ */
"use strict";

const ID = "opportunity";
const CAMPAIGN_RR_FLOOR = 2.0;   // a move worth surfacing clears 2:1 entry→final target
let SEQ = 0;
const mk = (o) => Object.assign({
  id: "opp_" + String(++SEQ).padStart(6,"0"),
  watcher: ID, status: "new",
  confirm: { basis: "belief-store" },
  links: { confirms:[], contradicts:[], coOccurs:[] },
  claimedBy: null, processedAt: null, resultBeliefIds: []
}, o);

const num  = s => parseFloat(String(s).replace(/[,$\s]/g, ""));
const isN  = n => typeof n === "number" && !isNaN(n) && isFinite(n);

/* Parse a prose setup into a CAMPAIGN. Conservative: anything not clearly
   stated is left null rather than guessed. */
function parseSetup(value){
  const v = String(value || "");
  const low = v.toLowerCase();

  const isShort = /\bshort\b|\bsell\b|\bfade\b/.test(low);
  const isLong  = /\blong\b|\bbuy\b/.test(low);
  const dir = isShort && !isLong ? "short" : isLong && !isShort ? "long"
            : isShort ? "short" : isLong ? "long" : null;

  /* entry zone: first "a–b" range (handles –, —, -, "to") */
  let zone = null;
  const zm = /(\d[\d,]*(?:\.\d+)?)\s*(?:[–—-]|to)\s*\$?\s*(\d[\d,]*(?:\.\d+)?)/.exec(v);
  if(zm){ const a = num(zm[1]), b = num(zm[2]); if(isN(a) && isN(b)) zone = [Math.min(a,b), Math.max(a,b)]; }

  /* stop */
  const sm = /stop\s*\$?\s*(\d[\d,]*(?:\.\d+)?)/i.exec(v);
  const stop = sm ? num(sm[1]) : null;

  /* targets: T1/T2/T3 markers, else a "→"/">" chain */
  let targets = [];
  for(const m of v.matchAll(/\bT\d\s*\$?\s*(\d[\d,]*(?:\.\d+)?)/gi)) targets.push(num(m[1]));
  if(!targets.length) for(const m of v.matchAll(/[→>]\s*\$?\s*(\d[\d,]*(?:\.\d+)?)/g)) targets.push(num(m[1]));
  targets = targets.filter(isN);

  /* stated R:R, if the author wrote one — used only as a cross-check */
  const rrm = /(\d+(?:\.\d+)?)\s*:\s*1/.exec(v);
  const statedRR = rrm ? +rrm[1] : null;

  /* size (a %, not a level) */
  let size = null;
  const sizes = (v.match(/(\d+(?:\.\d+)?)\s*%/g) || []).map(x => parseFloat(x)).filter(x => x > 0 && x <= 3);
  if(sizes.length) size = Math.min(...sizes);

  /* CAMPAIGN geometry — the whole point (doctrine principle 1).
     Best-location entry is NEAREST the invalidation (the rejection-candle
     method), so the R:R reflects the tight stop, not the far zone edge. */
  let entryBest = null, finalTarget = null, campaignRR = null, nearRR = null, risk = null;
  if(zone && isN(stop) && targets.length && dir){
    entryBest   = dir === "short" ? zone[1] : zone[0];          // edge nearest the stop
    finalTarget = dir === "short" ? Math.min(...targets) : Math.max(...targets);
    const nearTarget = dir === "short" ? Math.max(...targets) : Math.min(...targets);
    risk = dir === "short" ? stop - entryBest : entryBest - stop;
    if(risk > 0){
      campaignRR = +((dir === "short" ? entryBest - finalTarget : finalTarget - entryBest) / risk).toFixed(2);
      nearRR     = +((dir === "short" ? entryBest - nearTarget  : nearTarget  - entryBest) / risk).toFixed(2);
    }
  }
  return { dir, zone, stop, targets, finalTarget, entryBest, risk, campaignRR, nearRR, statedRR, size };
}

/* Lifecycle stage from a live price (optional). Returns a stage + whether an
   entry window is open. Continuation detection needs a small recent series. */
function stageOf(p, price, recent){
  if(!isN(price) || !p.dir || !p.zone) return { stage:"armed", entryOpen:false };
  const [lo, hi] = p.zone, tol = (hi - lo) * 0.15 || hi * 0.0005;
  const inZone     = price >= lo - tol && price <= hi + tol;
  const favourable = p.dir === "short" ? price < lo : price > hi;    // moved our way, out of the zone
  if(inZone) return { stage:"at-zone", entryOpen:true };
  if(!favourable) return { stage:"armed", entryOpen:false };

  /* running — is there a pullback toward the anchor right now? */
  let pulledBack = false;
  if(Array.isArray(recent) && recent.length >= 3){
    const anchor = p.dir === "short" ? hi : lo;
    const ext = p.dir === "short" ? Math.min(...recent.map(c => c.l ?? c.c ?? c))
                                  : Math.max(...recent.map(c => c.h ?? c.c ?? c));
    const span = Math.abs(anchor - ext) || 1;
    const retrace = p.dir === "short" ? (price - ext) / span : (ext - price) / span;
    pulledBack = retrace >= 0.33 && retrace <= 0.9;   // a real pullback, not a full reversal
  }
  return { stage: pulledBack ? "continuation" : "running", entryOpen: pulledBack };
}

/**
 * @param {BeliefStore} store
 * @param {object} opts {now, newsWindow:bool, hasPropAccount:bool, prices:{asset:number}, recent:{asset:[bars]}}
 */
function run(store, opts){
  opts = opts || {};
  const now = opts.now || Date.now();
  const all = store.all(null, now);
  const doctrine = all.filter(b => b.class === "doctrine");
  const setups = all.filter(b => b.class === "opportunity" && b.status !== "invalidated");
  const prices = opts.prices || {};
  const recentByAsset = opts.recent || {};
  const events = [];

  /* ---- execution scope (principle 3) — annotate, never suppress ---- */
  const personalGated = doctrine.some(b => /account\.personal/.test(b.key) && /no trade/i.test(String(b.value)));
  const scope = opts.newsWindow ? "watch-only"
              : personalGated   ? (opts.hasPropAccount ? "prop-only" : "watch-only")
              : "clear";
  const scopeWhy = opts.newsWindow ? "inside a high-impact news window"
                 : personalGated   ? "personal account NO-TRADE (grid unresolved)"
                 : "accounts clear";

  /* ---- score every setup as a CAMPAIGN (principle 1) ---- */
  const scored = setups.map(s => {
    const p = parseSetup(s.value);
    const conf = s.confidenceNow;
    /* structural validity is what matters (principle 2). Decay is advisory. */
    const structurallyValid = s.status !== "invalidated" && !!p.dir;
    const rr = p.campaignRR;
    const evProxy = isN(rr) ? +(conf * rr - (1 - conf)).toFixed(2) : null;
    const notes = [];
    if(s.demoted) notes.push("decayed — RE-CONFIRM the read (not dead: an armed setup is patient)");
    if(rr == null) notes.push("campaign R:R not computable — restate zone/stop/targets");
    /* VIABLE for surfacing = structurally valid, committed, and the CAMPAIGN
       clears the floor. Time-decay and the account gate are NOT here. */
    const viable = structurallyValid && (rr == null ? true : rr >= CAMPAIGN_RR_FLOOR)
                   && (evProxy == null ? true : evProxy > 0);
    const price = prices[s.asset];
    const st = stageOf(p, price, recentByAsset[s.asset]);
    return { s, p, conf, rr, nearRR:p.nearRR, evProxy, viable, structurallyValid, notes,
             price, stage: st.stage, entryOpen: st.entryOpen };
  }).sort((a,b) => (b.rr ?? -9) - (a.rr ?? -9));   // rank by CAMPAIGN R:R, not near-target

  const viable = scored.filter(x => x.viable);

  /* ---- the answer ---- */
  if(!viable.length){
    /* NO_TRADE only when there is genuinely no valid campaign (principle 4). */
    events.push(mk({
      t: now, asset: null, type: "NO_TRADE", tier: 1,
      fact: setups.length
        ? `Stand down — no structurally-valid campaign on the board. `
          + `${setups.length} setup${setups.length===1?"":"s"} examined, ${viable.length} valid.`
        : `Stand down — no setups armed.`,
      evidence: { scope, scopeWhy,
                  detail: scored.map(x => ({ key:x.s.key, dir:x.p.dir, campaignRR:x.rr,
                                             ev:x.evProxy, valid:x.structurallyValid, notes:x.notes })) },
      affects: [], confidence: 0.85
    }));
    return { events, setups: setups.length, viable: 0, scope, scored };
  }

  /* PRIMARY_MOVE — the best campaign, surfaced regardless of decay or gate. */
  const top = viable[0], p = top.p;
  const tgt = p.finalTarget, zoneTxt = p.zone ? `${p.zone[0]}–${p.zone[1]}` : "—";
  events.push(mk({
    t: now, asset: top.s.asset, type: "PRIMARY_MOVE", tier: 1,
    fact: `${top.s.asset} ${p.dir ? p.dir.toUpperCase() : ""} — the move is the campaign ${zoneTxt} → ${tgt}. `
        + `Campaign R:R ${top.rr}:1 (near-target ${top.nearRR}:1). `
        + `EXECUTION: ${scope.toUpperCase()} (${scopeWhy}). `
        + `Enter tight on the rejection near ${p.stop} — do not fade at the zone with a far stop.`,
    evidence: {
      key: top.s.key, dir: p.dir, zone: p.zone, stop: p.stop, finalTarget: tgt,
      entryBest: p.entryBest, campaignRR: top.rr, nearRR: top.nearRR, evProxy: top.evProxy,
      confidenceNow: +top.conf.toFixed(2), stage: top.stage, executionScope: scope, scopeWhy,
      size: p.size, invalidator: top.s.invalidator || null, notes: top.notes,
      runnersUp: viable.slice(1,3).map(x => ({ key:x.s.key, campaignRR:x.rr })),
      note: "R:R is entry→FINAL target (the campaign), not the near target. EV is a proxy from decayed confidence × campaign R:R."
    },
    affects: [top.s.key], confidence: Math.min(0.9, (top.conf || 0.5) + 0.15)
  }));

  /* ENTRY / CONTINUATION windows for any viable setup with a live price. */
  for(const x of viable){
    if(x.stage === "at-zone" && x.entryOpen){
      events.push(mk({
        t: now, asset: x.s.asset, type: "ENTRY_WINDOW", tier: 1,
        fact: `${x.s.asset} ${x.p.dir.toUpperCase()} — price is IN the entry zone ${x.p.zone[0]}–${x.p.zone[1]}. `
            + `Wait for the rejection candle, then enter with the stop just beyond ${x.p.stop}.`,
        evidence: { key:x.s.key, price:x.price, zone:x.p.zone, stop:x.p.stop, campaignRR:x.rr, scope },
        affects: [x.s.key], confidence: 0.75
      }));
    } else if(x.stage === "continuation" && x.entryOpen){
      events.push(mk({
        t: now, asset: x.s.asset, type: "CONTINUATION_WINDOW", tier: 1,
        fact: `${x.s.asset} ${x.p.dir.toUpperCase()} campaign RUNNING and price pulled back toward the anchor `
            + `(now ${x.price}). A continuation entry to join the move — stop beyond the last swing.`,
        evidence: { key:x.s.key, price:x.price, zone:x.p.zone, finalTarget:x.p.finalTarget, campaignRR:x.rr, scope },
        affects: [x.s.key], confidence: 0.7
      }));
    }
  }

  return { events, setups: setups.length, viable: viable.length, scope, scored };
}

function summarise(res){
  const pm = res.events.find(e => e.type === "PRIMARY_MOVE");
  const ew = res.events.filter(e => e.type === "ENTRY_WINDOW").length;
  const cw = res.events.filter(e => e.type === "CONTINUATION_WINDOW").length;
  const no = res.events.find(e => e.type === "NO_TRADE");
  return `${res.setups} setups · ${res.viable} valid campaign${res.viable===1?"":"s"} · scope ${res.scope}`
       + (ew ? ` · ${ew} entry window${ew>1?"s":""}` : "")
       + (cw ? ` · ${cw} continuation` : "")
       + ` → ${pm ? "PRIMARY MOVE ("+pm.asset+")" : no ? "NO TRADE" : "—"}`;
}

module.exports = { run, summarise, parseSetup, stageOf, id: ID, PINNED: true, CAMPAIGN_RR_FLOOR };
