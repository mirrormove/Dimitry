/* ============================================================
   EVENT LOG                  Vault Intelligence v4 · Phase 1
   Append-only NDJSON. Zero dependencies.

   Transport-agnostic by design (spec §12): the same claim/process
   protocol serves the Phase-3a scheduled drain and the Phase-3b API
   worker with no schema change. Latency differs; nothing else does.

   Phase 1: every event lands with status "shadow" and NOTHING consumes
   it. Events only become claimable once their watcher passes the
   calibration gate.
   ============================================================ */
"use strict";
const fs   = require("fs");
const path = require("path");

class EventLog {
  constructor(file){
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive:true });
  }
  append(events){
    const arr = Array.isArray(events) ? events : [events];
    if(!arr.length) return 0;
    fs.appendFileSync(this.file, arr.map(e => JSON.stringify(e)).join("\n") + "\n");
    return arr.length;
  }
  all(){
    if(!fs.existsSync(this.file)) return [];
    return fs.readFileSync(this.file, "utf8").split("\n").filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch(e){ return null; } }).filter(Boolean);
  }
  /** Latest state per event id — the log is append-only, so later lines win. */
  current(){
    const m = new Map();
    for(const e of this.all()) m.set(e.id, e);
    return [...m.values()];
  }
  /** T2–T4, unprocessed, not shadow — what the reasoning layer would drain. */
  claimable(){
    return this.current().filter(e => e.tier >= 2 && e.status === "new");
  }
  unprocessedCount(){ return this.claimable().length; }

  /** Atomically mark claimed (append a new line — never mutate history). */
  claim(ids, by){
    const now = Date.now();
    const upd = this.current().filter(e => ids.includes(e.id) && e.status === "new")
      .map(e => Object.assign({}, e, { status:"claimed", claimedBy:by||"drain", claimedAt:now }));
    this.append(upd);
    return upd;
  }
  /** Idempotent: re-processing an already-processed event is a no-op. */
  process(id, resultBeliefIds){
    const e = this.current().find(x => x.id === id);
    if(!e || e.status === "processed") return null;
    const done = Object.assign({}, e, { status:"processed", processedAt:Date.now(),
                                        resultBeliefIds: resultBeliefIds || [] });
    this.append(done);
    return done;
  }
  stats(){
    const cur = this.current(), by = {};
    for(const e of cur){
      by[e.status] = (by[e.status]||0)+1;
    }
    const byWatcher = {}, byType = {};
    cur.forEach(e => { byWatcher[e.watcher]=(byWatcher[e.watcher]||0)+1;
                       byType[e.type]=(byType[e.type]||0)+1; });
    return { total:cur.length, byStatus:by, byWatcher, byType, claimable:this.claimable().length };
  }
}

module.exports = { EventLog };
