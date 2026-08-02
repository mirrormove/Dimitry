/* ============================================================
   DIMITRY · BELIEF STORE          Vault Intelligence v4 · Phase 0
   Zero dependencies — pure Node built-ins.

   The vault (.md) is the human-readable KNOWLEDGE BASE.
   This file is the machine-readable CURRENT STATE ("RAM").

   Two hard rules from the spec (99_System/Vault Intelligence v4):
     1. Beliefs are NEVER overwritten in place — a new record
        SUPERSEDES the old one and the chain is preserved.
        (Calibration depends on being able to replay history.)
     2. Every belief carries its OWN clock (setAt) and decays
        toward its prior, so "stale" is per-claim, not per-file.

   Vocabulary:
     key  — stable identity of a claim   "BTCUSDT.structure.4H"
     uid  — identity of one RECORD of that claim   "blf_000042"
   ============================================================ */
"use strict";
const fs   = require("fs");
const path = require("path");

/* ---- decay half-lives, in hours (spec §9) ------------------ */
const HALF_LIFE_H = {
  sentiment:  12,
  flow:       12,
  structure:  48,
  opportunity:24,
  macro:     168,
  regime:    168,
  correlation:336,
  doctrine:  Infinity     // risk ceilings are not evidence-dependent
};
/* Demotion (→ T4) is about INFORMATION LOST TO TIME, not about low confidence.
   A belief set at 0.50 (an honest coin-flip) never claimed anything, so it can
   never "decay" — it is uncertain, not stale. A belief set at 0.89 that has
   drifted halfway back to its prior HAS gone stale, and should be re-examined.

   demoted  ⇔  it made a real claim (distance ≥ MIN_CLAIM from prior)
               AND has lost ≥ half of that claim to decay (i.e. age ≥ 1 half-life)   */
const MIN_CLAIM   = 0.05;   // below this it never asserted anything
const DECAY_FLOOR = 0.50;   // fraction of the original claim still standing
/* kept for callers that want the absolute view */
const DEMOTE_FLOOR = 0.55;

const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;

/** Confidence decays toward the prior. Doctrine never decays. */
function decayedConfidence(b, now){
  const hl = b.halfLifeH != null ? b.halfLifeH : (HALF_LIFE_H[b.class] || 48);
  if(!isFinite(hl)) return b.confidence;
  const prior = b.prior != null ? b.prior : 0.5;
  const dtH   = Math.max(0, (now - b.setAt) / 3.6e6);
  return clamp01(prior + (b.confidence - prior) * Math.pow(2, -dtH / hl));
}

class BeliefStore {
  constructor(file){
    this.file    = file;
    this.records = [];    // append-only log of every belief record ever set
    this.current = {};    // key -> uid of the newest record
    this.seq     = 0;
    this._dirty  = false;
  }

  /* ---- persistence --------------------------------------- */
  load(){
    try{
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.records = raw.records || [];
      this.current = raw.current || {};
      this.seq     = raw.seq || this.records.length;
    }catch(e){ /* first run — empty store */ }
    return this;
  }
  save(){
    const tmp = this.file + ".tmp";
    const payload = { version:4, savedAt:Date.now(),
                      seq:this.seq, current:this.current, records:this.records };
    fs.mkdirSync(path.dirname(this.file), { recursive:true });
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 1));
    fs.renameSync(tmp, this.file);          // atomic — never a half-written store
    this._dirty = false;
    return this;
  }

  /* ---- write --------------------------------------------- */
  /**
   * Set a belief. Always appends a NEW record superseding the previous
   * one for that key. Returns the stored record.
   *   set({ key, claim, value, confidence, class, setBy, evidence, invalidator, asset })
   */
  set(b){
    if(!b || !b.key) throw new Error("belief.key is required");
    if(!b.class)     throw new Error("belief.class is required ("+b.key+")");
    const now  = b.setAt || Date.now();
    const prev = this.current[b.key] || null;
    const uid  = "blf_" + String(++this.seq).padStart(6, "0");
    const rec = {
      uid, key:b.key,
      claim:      b.claim || b.key,
      value:      b.value,
      confidence: clamp01(b.confidence == null ? 0.6 : b.confidence),
      prior:      b.prior == null ? 0.5 : b.prior,
      class:      b.class,
      halfLifeH:  b.halfLifeH != null ? b.halfLifeH
                  : (HALF_LIFE_H[b.class] != null ? HALF_LIFE_H[b.class] : 48),
      asset:      b.asset || null,
      evidence:   b.evidence   || [],
      correlates: b.correlates || [],
      invalidator:b.invalidator || null,
      setAt:      now,
      setBy:      b.setBy || "agent",
      supersedes: prev,
      source:     b.source || null        // e.g. the .md note this came from
    };
    this.records.push(rec);
    this.current[b.key] = uid;
    this._dirty = true;
    return rec;
  }

  /* ---- read ---------------------------------------------- */
  _byUid(uid){ return this.records.find(r => r.uid === uid) || null; }

  /** Current record for a key, with confidence decayed to `now`. */
  get(key, now){
    now = now || Date.now();
    const uid = this.current[key];
    if(!uid) return null;
    const r = this._byUid(uid);
    if(!r) return null;
    const conf  = decayedConfidence(r, now);
    const prior = r.prior != null ? r.prior : 0.5;
    const dist0 = Math.abs(r.confidence - prior);        // what it originally claimed
    const distN = Math.abs(conf - prior);                // what still stands
    const ratio = dist0 > 0 ? distN / dist0 : 1;
    return Object.assign({}, r, {
      confidenceNow: conf,
      ageH:  (now - r.setAt) / 3.6e6,
      ageMs: now - r.setAt,
      claim0: dist0,                 // strength of the original assertion
      decayRatio: ratio,             // 1 = intact, 0.5 = one half-life elapsed
      /* stale ⇔ it asserted something AND has lost half of it to time */
      demoted: r.class !== "doctrine" && dist0 >= MIN_CLAIM && ratio < DECAY_FLOOR,
      /* separate, honest signal: it simply never claimed much */
      uncommitted: r.class !== "doctrine" && dist0 < MIN_CLAIM
    });
  }

  /** All current beliefs, optionally filtered. */
  all(filter, now){
    now = now || Date.now();
    filter = filter || {};
    return Object.keys(this.current)
      .map(k => this.get(k, now))
      .filter(Boolean)
      .filter(b => (!filter.asset || b.asset === filter.asset))
      .filter(b => (!filter.class || b.class === filter.class))
      .sort((a,b) => a.ageMs - b.ageMs);
  }

  /** Full supersede chain for a key, newest first. */
  history(key){
    const out = [];
    let uid = this.current[key];
    while(uid){
      const r = this._byUid(uid);
      if(!r) break;
      out.push(r);
      uid = r.supersedes;
    }
    return out;
  }

  /* ---- the Contradiction watcher's Phase-0 half ----------- */
  /**
   * Beliefs that have decayed below the floor. Returns T4 event stubs
   * for the caller to enqueue — the store never emits events itself.
   */
  sweep(now){
    now = now || Date.now();
    return this.all(null, now)
      .filter(b => b.demoted)
      .map(b => ({
        t:now, asset:b.asset, watcher:"contradiction", type:"BELIEF_DECAYED", tier:4,
        fact:`"${b.claim}" has lost ${((1-b.decayRatio)*100).toFixed(0)}% of its original claim to time `
            +`(${(b.confidence*100).toFixed(0)}% → ${(b.confidenceNow*100).toFixed(0)}% over ${b.ageH.toFixed(1)}h) — re-examine`,
        evidence:{ key:b.key, setAt:b.setAt, confidenceSet:b.confidence,
                   confidenceNow:b.confidenceNow, decayRatio:b.decayRatio, halfLifeH:b.halfLifeH },
        affects:[b.key], status:"new"
      }));
  }

  /**
   * Freshness, the v4 way (spec §13): NOT a file date.
   * "Nothing changed for 6h" is HEALTHY. Unprocessed events are not.
   */
  freshness(now, unprocessedT2plus){
    now = now || Date.now();
    const bs = this.all(null, now).filter(b => b.class !== "doctrine");
    const oldest = bs.length ? bs[bs.length-1] : null;
    const demoted     = bs.filter(b => b.demoted);
    const uncommitted = bs.filter(b => b.uncommitted);
    const unproc      = unprocessedT2plus || 0;
    let state = "CURRENT", why = "all beliefs within their half-life";
    if(unproc > 0){ state = "UNPROCESSED"; why = `${unproc} event${unproc>1?"s":""} awaiting reasoning`; }
    else if(demoted.length){ state = "DECAYED"; why = `${demoted.length} belief${demoted.length>1?"s":""} past one half-life — re-examine`; }
    return { state, why, beliefs:bs.length, demoted:demoted.length,
             uncommitted:uncommitted.length, unprocessed:unproc,
             oldestKey: oldest ? oldest.key : null,
             oldestAgeH: oldest ? +oldest.ageH.toFixed(2) : null };
  }
}

module.exports = { BeliefStore, decayedConfidence, HALF_LIFE_H, DEMOTE_FLOOR };
