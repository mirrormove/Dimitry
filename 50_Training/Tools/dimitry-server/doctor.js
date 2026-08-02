/* ============================================================
   DIMITRY — SELF-DIAGNOSTICS ("doctor")   Vault Intelligence v4
   Zero runtime deps.  One command: node doctor.js

   Answers "is Dimitry running perfectly?" by checking every subsystem against
   an invariant and reporting PASS / WARN / FAIL, then an overall verdict. Safe:
   read-only except a dry worker pass (which is idempotent).
   ============================================================ */
"use strict";
const fs = require("fs"), path = require("path"), cp = require("child_process");
const HERE = __dirname, TOOLS = path.resolve(HERE, "..");
const R = { pass:0, warn:0, fail:0, rows:[] };
const line = (state, area, detail) => { R[state.toLowerCase()]++; R.rows.push({ state, area, detail }); };
const PASS=(a,d)=>line("PASS",a,d), WARN=(a,d)=>line("WARN",a,d), FAIL=(a,d)=>line("FAIL",a,d);
const tryReq = p => { try { return require(p); } catch(e){ return { __err:String(e.message||e) }; } };

(async () => {

/* ---- 1 · MODULES LOAD ---- */
const mods = ["belief-store.js","watchers/event-log.js","watchers/contradiction.js","watchers/opportunity.js",
  "watchers/macro.js","watchers/confluence.js","watchers/watch-manager.js","rules/engine.js","rules/drain.js","rules/auto-disposition.js","rules/worker.js","rules/reconcile.js",
  "calibration/score.js","calibration/base-rates.js","calibration/ascent.js"];
let loadOk = 0;
for(const m of mods){ const r = tryReq("./"+m); if(r.__err) FAIL("module", `${m} — ${r.__err}`); else loadOk++; }
if(loadOk === mods.length) PASS("modules", `${loadOk}/${mods.length} core modules load`);

/* ---- 2 · TEST SUITES ---- */
const suites = ["watchers/test-belief-watchers.js","watchers/test-watchers.js","watchers/test-macro.js","watchers/test-confluence.js",
  "rules/test-rules.js","rules/test-drain.js","rules/test-worker.js","rules/test-reconcile.js",
  "watchers/test-watch-manager.js","calibration/test-base-rates.js","calibration/test-score.js","calibration/test-ascent.js"];
let green=0, assertions=0;
for(const s of suites){
  try{ const out = cp.execSync(`node ${s}`, { cwd:HERE, stdio:["ignore","pipe","pipe"] }).toString();
    const m = out.match(/ALL (\d+) PASS/); if(m){ green++; assertions += +m[1]; } else FAIL("tests", `${s} not green`);
  }catch(e){ FAIL("tests", `${s} FAILED`); }
}
if(green === suites.length) PASS("tests", `${green}/${suites.length} suites green · ${assertions} assertions`);

/* ---- 3 · BELIEF STORE INTEGRITY ---- */
const { BeliefStore } = tryReq("./belief-store.js");
let store;
try{
  store = new BeliefStore(path.resolve(TOOLS,"beliefs.json")).load();
  const now = Date.now();
  const all = store.all(null, now);
  PASS("beliefs", `${all.length} live beliefs load`);
  const doctrine = all.filter(b=>b.class==="doctrine");
  doctrine.length ? PASS("beliefs", `${doctrine.length} doctrine beliefs present`) : WARN("beliefs","no doctrine beliefs");
  // every current uid resolves to a record
  const raw = JSON.parse(fs.readFileSync(path.resolve(TOOLS,"beliefs.json"),"utf8"));
  const uids = new Set((raw.records||[]).map(r=>r.uid));
  const dangling = Object.values(raw.current||{}).filter(u=>!uids.has(u));
  dangling.length ? FAIL("beliefs", `${dangling.length} current pointers have no record`) : PASS("beliefs","history chain intact (all current uids resolve)");
  // directional non-doctrine beliefs should carry an invalidator (falsifiability)
  const { statedDirection } = tryReq("./watchers/contradiction.js");
  const unguarded = all.filter(b=>b.class!=="doctrine" && b.status!=="invalidated" && !b.invalidator && statedDirection && statedDirection(b));
  unguarded.length ? WARN("beliefs", `${unguarded.length} directional belief(s) without an invalidator: ${unguarded.map(b=>b.key).join(", ")}`)
                   : PASS("beliefs","every directional belief is falsifiable (has an invalidator)");
  // decay pressure
  const decayed = store.sweep(now);
  decayed.length===0 ? PASS("freshness","no decayed beliefs awaiting refresh")
    : decayed.length<=3 ? WARN("freshness", `${decayed.length} decayed belief(s) — the worker re-affirms these`)
    : FAIL("freshness", `${decayed.length} decayed beliefs piling — is the worker running?`);
}catch(e){ FAIL("beliefs", "store failed to load: "+e.message); }

/* ---- 4 · EVENT LOG + DEDUP ---- */
try{
  const { EventLog } = tryReq("./watchers/event-log.js");
  const log = new EventLog(path.resolve(TOOLS,"events.ndjson"));
  const unp = log.unprocessedCount();
  unp===0 ? PASS("eventlog","0 unprocessed events — the loop is drained")
    : unp<=15 ? WARN("eventlog", `${unp} unprocessed — a drain/worker pass will clear it`)
    : FAIL("eventlog", `${unp} unprocessed events — the loop is backing up`);
  fs.existsSync(path.resolve(TOOLS,"watcher-seen.json"))
    ? PASS("dedup","cross-run dedup file present (watcher-seen.json)")
    : WARN("dedup","no watcher-seen.json — dedup will rebuild on restart");
}catch(e){ FAIL("eventlog","event log check failed: "+e.message); }

/* ---- 5 · WATCHERS RUN CLEAN ---- */
if(store){
  const now = Date.now();
  for(const [id,mod] of [["contradiction","./watchers/contradiction.js"],["opportunity","./watchers/opportunity.js"],["macro","./watchers/macro.js"],["confluence","./watchers/confluence.js"]]){
    try{ const w = tryReq(mod); const r = w.run(store,{now}); PASS("watchers", `${id} runs (${r.events.length} events)`); }
    catch(e){ FAIL("watchers", `${id} threw: ${e.message}`); }
  }
}

/* ---- 6 · WORKER (closed loop) dry pass ---- */
if(store){
  try{
    const { EventLog } = tryReq("./watchers/event-log.js");
    const { runWorker } = tryReq("./rules/worker.js");
    const log = new EventLog(path.resolve(TOOLS,"events.ndjson"));
    const r = await runWorker(log, store, { now: Date.now() });
    PASS("worker", r.empty ? "queue empty — nothing to settle (loop closed)" : `settled ${r.tier0} at Tier-0, ${r.escalated} escalated`);
  }catch(e){ FAIL("worker","worker threw: "+e.message); }
}

/* ---- 7 · CALIBRATION + ASCENT ARTIFACTS ---- */
try{
  const br = JSON.parse(fs.readFileSync(path.resolve(TOOLS,"base-rates.json"),"utf8"));
  const cats = br.categories||[]; const sum = cats.reduce((a,c)=>a+c.n,0);
  (br.portfolio && sum===br.portfolio.n) ? PASS("calibration", `base-rates.json present · ${cats.length} categories reconcile to n=${br.portfolio.n}`)
                                         : WARN("calibration","base-rates.json present but does not reconcile");
  br.detectors && br.detectors.length ? PASS("calibration", `detector edge folded in (${br.detectors.filter(d=>d.usable).length} usable)`) : WARN("calibration","no detector edge");
}catch(e){ WARN("calibration","base-rates.json missing — run calibration/base-rates.js"); }
try{
  const sm = JSON.parse(fs.readFileSync(path.resolve(TOOLS,"self-model.json"),"utf8"));
  const h = sm.history||[]; PASS("ascent", `self-model.json present · ${h.length} snapshot(s) · EQ ${h.length?h[h.length-1].eq:"—"}`);
}catch(e){ WARN("ascent","self-model.json missing — run calibration/ascent.js"); }

/* ---- 7b · WATCH MANAGER allocation ---- */
if(store){
  try{ const WM = tryReq("./watchers/watch-manager.js"); const plan = WM.allocate(store, { now:Date.now() });
    plan.spent <= plan.budget + 1e-9
      ? PASS("attention", `allocated ${plan.active} active / ${plan.light} light / ${plan.hibernate} hibernate (budget ${plan.spent}/${plan.budget})`)
      : FAIL("attention", `over budget: ${plan.spent} > ${plan.budget}`);
  }catch(e){ FAIL("attention","watch-manager threw: "+e.message); }
}

/* ---- 8 · SCHEDULES / WIRING (static) ---- */
try{
  const srv = fs.readFileSync(path.resolve(HERE,"server.js"),"utf8");
  const wired = ["runBeliefWatchers","runAutoWorker","/api/base-rates","/api/ascent","/api/worker","MACRO"].filter(k=>srv.includes(k));
  wired.length>=5 ? PASS("wiring", `daemon wires ${wired.length}/6 subsystems`) : WARN("wiring", `only ${wired.length}/6 wired`);
}catch(e){ WARN("wiring","could not read server.js"); }

/* ---- REPORT ---- */
const icon = s => s==="PASS"?"✓":s==="WARN"?"▲":"✗";
console.log("\n  DIMITRY · SELF-DIAGNOSTICS  ·  " + new Date().toISOString().slice(0,16).replace("T"," ") + "\n");
for(const r of R.rows) console.log(`  ${icon(r.state)} [${r.area.padEnd(11)}] ${r.detail}`);
const total = R.pass+R.warn+R.fail;
const verdict = R.fail>0 ? "NEEDS ATTENTION" : R.warn>0 ? "HEALTHY (with notes)" : "PERFECT HEALTH";
console.log(`\n  ${R.pass}/${total} pass · ${R.warn} warn · ${R.fail} fail  →  ${verdict}\n`);
process.exit(R.fail>0?1:0);
})();
