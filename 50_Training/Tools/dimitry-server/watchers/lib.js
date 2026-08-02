/* ============================================================
   DIMITRY · WATCHER CORE          Vault Intelligence v4 · Phase 1
   Zero dependencies.

   Shared primitives + THE DEBOUNCE LAYER.

   Every guard in here is an existing piece of the operator's trading
   doctrine, moved INSIDE the detector (spec §10). This is deliberate:
   the vault's measured leaks were produced by ignoring these rules by
   hand, so a detector that ignores them would reproduce the same leak
   automatically and at scale.

     close-basis     ← `needsClose` on setups
     0.1% offset     ← le_005 (stop swept by 3 pts), le_013 (entry missed by 6 pts)
     volume arbiter  ← le_014 (the 67,292 breakout that failed the volume gate)
     cooldown/hysteresis/storm ← anti-whipsaw

   Candle shape (one object per bar, ascending time):
     { t, o, h, l, c, v }
   ============================================================ */
"use strict";

/* ---- doctrine constants ------------------------------------ */
const OFFSET_PCT   = 0.1;    // default (crypto). Per-class values below.
const VOL_MULT     = 1.5;    // breakout confirmation: volume > 1.5× average
const STORM_MAX_H  = 3;      // max T2 events per asset per rolling hour

/* The offset rule must be ASSET-CLASS RELATIVE.
   Found while testing le_031: GBPUSD closed 1.3352 through the 1.3360 shelf —
   a real, decisive break that price never looked back from — but that is only
   0.06%, so a flat 0.1% offset SUPPRESSED it. 0.1% on FX is ~13 pips: an
   enormous move. Applying a crypto-sized offset to FX would have made the
   watcher blind to exactly the break that put the 07-21 FX book on the wrong
   side. Same logic as the existing per-class STOP_CEIL doctrine. */
const OFFSET_BY_CLASS = { crypto:0.10, metals:0.06, fx:0.03, index:0.06, other:0.08 };
function classOf(asset){
  if(/BTC|ETH|USDT|SOL|XRP|DOGE|PAXG$/i.test(asset) && !/^XAU/i.test(asset)) return "crypto";
  if(/^XAU|^XAG|GOLD|SILVER/i.test(asset)) return "metals";
  if(/^(EUR|GBP|USD|AUD|NZD|CAD|CHF|JPY){2}$/i.test(asset)) return "fx";
  if(/NAS|SPX|DXY|US30|DAX/i.test(asset)) return "index";
  return "other";
}
const offsetFor = asset => OFFSET_BY_CLASS[classOf(asset)] ?? OFFSET_PCT;

const TF_MS = { "1m":6e4, "5m":3e5, "15m":9e5, "30m":18e5, "1H":36e5, "4H":144e5, "1D":864e5, "1W":6048e5 };

/* ---- maths ------------------------------------------------- */
function atr(c, n){
  n = n || 14;
  if(c.length < 2) return null;
  const tr = [];
  for(let i=1;i<c.length;i++)
    tr.push(Math.max(c[i].h-c[i].l, Math.abs(c[i].h-c[i-1].c), Math.abs(c[i].l-c[i-1].c)));
  const s = tr.slice(-n);
  return s.reduce((a,b)=>a+b,0)/s.length;
}
function avgVol(c, n){
  n = n || 20;
  const s = c.slice(-n).map(x=>x.v||0).filter(v=>v>0);
  return s.length ? s.reduce((a,b)=>a+b,0)/s.length : null;
}

/**
 * Confirmed swing pivots. `bars` candles on EACH side must be lower/higher.
 * This parameter IS the structural opinion — it ships versioned and is
 * scored against the frozen benchmark before any change deploys (spec §11.2).
 */
function pivots(c, bars, minProminenceAtr){
  bars = bars || 2;
  /* SIGNIFICANCE FILTER (added Step 2c, after the first real replay).
     A bare 2-bar pivot is any local wiggle: the detectors produced ~0.3
     events/bar against a record containing ~1 structural event per week.
     The operator's swing points STAND OUT — they clear the surrounding
     range by a meaningful fraction of ATR. Prominence is that difference,
     measured against the opposite extreme of the lookback window.
     minProminenceAtr = 0 restores the old behaviour for A/B comparison. */
  const prom = minProminenceAtr == null ? 0 : minProminenceAtr;
  const A = prom > 0 ? atr(c, 14) : null;
  const highs = [], lows = [];
  for(let i=bars;i<c.length-bars;i++){
    let isH = true, isL = true;
    for(let k=1;k<=bars;k++){
      if(!(c[i].h > c[i-k].h && c[i].h > c[i+k].h)) isH = false;
      if(!(c[i].l < c[i-k].l && c[i].l < c[i+k].l)) isL = false;
    }
    if(isH && prom > 0 && A){
      const win = c.slice(Math.max(0,i-bars*3), Math.min(c.length,i+bars*3+1));
      const floor = Math.min(...win.map(x=>x.l));
      if((c[i].h - floor) < A * prom) isH = false;
    }
    if(isL && prom > 0 && A){
      const win = c.slice(Math.max(0,i-bars*3), Math.min(c.length,i+bars*3+1));
      const ceil = Math.max(...win.map(x=>x.h));
      if((ceil - c[i].l) < A * prom) isL = false;
    }
    if(isH) highs.push({ i, t:c[i].t, p:c[i].h });
    if(isL) lows.push({ i, t:c[i].t, p:c[i].l });
  }
  return { highs, lows };
}

/* ---- doctrine guards --------------------------------------- */
/** Beyond the level by at least the offset — never AT the obvious number. */
function beyond(price, level, dir, offsetPct){
  const o = (offsetPct == null ? OFFSET_PCT : offsetPct) / 100;
  return dir === "up" ? price > level * (1 + o) : price < level * (1 - o);
}
/** Volume arbiter. Returns {passed, mult} — an unconfirmed break is still emitted, flagged. */
function volumeGate(c, mult){
  const av = avgVol(c.slice(0,-1));
  const last = c[c.length-1];
  if(!av || !last || !last.v) return { passed:null, mult:null };   // no volume feed (FX) — honest null
  const m = last.v / av;
  return { passed: m >= (mult || VOL_MULT), mult:+m.toFixed(2) };
}

/**
 * Debouncer — cooldown + hysteresis + storm guard, per (asset,type,level).
 * Stateful across calls; the watcher owns one instance.
 */
class Debouncer {
  constructor(opts){
    opts = opts || {};
    this.cooldownMs = opts.cooldownMs || TF_MS["1H"];
    this.stormMax   = opts.stormMax   || STORM_MAX_H;
    this.last  = {};      // key -> t of last emit
    this.armed = {};      // key -> bool (hysteresis: must re-enter the band to re-arm)
    this.recent= [];      // [{asset,t}] for the storm guard
  }
  _key(e){ return `${e.asset}|${e.type}|${e.level==null?"-":Math.round(e.level*1e4)}`; }

  /** @returns {allow:boolean, reason:string} */
  check(e){
    const k = this._key(e);
    if(this.last[k] != null && e.t - this.last[k] < this.cooldownMs)
      return { allow:false, reason:"cooldown" };
    if(this.armed[k] === false)
      return { allow:false, reason:"not re-armed (hysteresis)" };
    const hourAgo = e.t - 36e5;
    const n = this.recent.filter(r => r.asset === e.asset && r.t >= hourAgo).length;
    if(n >= this.stormMax)
      return { allow:false, reason:"storm guard — consolidate into CONFLUENCE" };
    return { allow:true, reason:"" };
  }
  commit(e){
    const k = this._key(e);
    this.last[k] = e.t;
    this.armed[k] = false;                       // must re-arm before firing again
    this.recent.push({ asset:e.asset, t:e.t });
    this.recent = this.recent.filter(r => r.t >= e.t - 36e5);
  }
  /** Price returned inside the band → the level may fire again. */
  rearm(asset, type, level){
    this.armed[`${asset}|${type}|${level==null?"-":Math.round(level*1e4)}`] = true;
  }
}

/* ---- event factory ----------------------------------------- */
let SEQ = 0;
function makeEvent(o){
  return {
    id: "evt_" + String(++SEQ).padStart(6,"0"),
    t: o.t, asset: o.asset, watcher: o.watcher, type: o.type,
    tier: o.tier == null ? 2 : o.tier,
    tf: o.tf || null,
    level: o.level == null ? null : o.level,
    fact: o.fact,                       // FACT ONLY — never an interpretation (spec §3)
    evidence: o.evidence || {},
    confirm: o.confirm || {},
    confidence: o.confidence == null ? null : o.confidence,
    links: { confirms:[], contradicts:[], coOccurs:[] },
    affects: o.affects || [],
    status: o.status || "shadow",       // Phase 1: everything is shadow until it passes the gate
    claimedBy: null, processedAt: null, resultBeliefIds: []
  };
}

module.exports = { atr, avgVol, pivots, beyond, volumeGate, Debouncer, makeEvent,
                   OFFSET_PCT, OFFSET_BY_CLASS, classOf, offsetFor, VOL_MULT, STORM_MAX_H, TF_MS };
