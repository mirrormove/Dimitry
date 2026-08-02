/* ============================================================
   DRAIN CLI                  Vault Intelligence v4 · Step 7b
   Zero dependencies.

   The transport a SCHEDULED AGENT RUN uses. It talks to the vault
   files directly — no HTTP, no running server required — so an
   unattended session can drain the queue exactly the way the
   /api/drain endpoint does. Same claim/apply protocol (spec §12);
   only the transport differs.

   Usage
     node rules/drain-cli.js peek        brief WITHOUT claiming
     node rules/drain-cli.js claim       claim the queue + write the brief
     node rules/drain-cli.js apply f.json  record the agent's conclusions
     node rules/drain-cli.js status      queue + belief health, one line

   Writes  50_Training/Tools/drain-brief.md    (what the agent reads)
           50_Training/Tools/drain-claim.json  (the ids it claimed)
   ============================================================ */
"use strict";
const fs   = require("fs");
const path = require("path");
const { BeliefStore } = require("../belief-store.js");
const { EventLog }    = require("../watchers/event-log.js");
const DR   = require("./drain.js");
const CONTRA = require("../watchers/contradiction.js");
const OPP    = require("../watchers/opportunity.js");

const TOOLS   = path.resolve(__dirname, "..", "..");
const BELIEFS = path.join(TOOLS, "beliefs.json");
const EVENTS  = path.join(TOOLS, "events.ndjson");
const BRIEF   = path.join(TOOLS, "drain-brief.md");
const CLAIMF  = path.join(TOOLS, "drain-claim.json");

const store = new BeliefStore(BELIEFS).load();
const log   = new EventLog(EVENTS);

/* Refresh the belief watchers first, so the queue reflects the store as it is
   NOW rather than as it was when the daemon last ticked. A scheduled run may
   happen when the server is not even up. */
function refreshWatchers(now){
  const seen = new Set(log.current().map(e => `${e.type}|${(e.affects||[]).join(",")}|${new Date(e.t).toISOString().slice(0,13)}`));
  const c = CONTRA.run(store, { now }), o = OPP.run(store, { now });
  const fresh = c.events.concat(o.events).filter(e =>
    !seen.has(`${e.type}|${(e.affects||[]).join(",")}|${new Date(e.t||now).toISOString().slice(0,13)}`));
  if(fresh.length) log.append(fresh);
  return { added: fresh.length, contradiction: CONTRA.summarise(c), opportunity: OPP.summarise(o) };
}

const cmd = process.argv[2] || "status";
const now = Date.now();

if(cmd === "status"){
  const w = refreshWatchers(now);
  const f = store.freshness(now, log.unprocessedCount());
  console.log(`queue ${log.unprocessedCount()} unprocessed (+${w.added} new) · ${f.state}: ${f.why}`);
  console.log(`  ${w.contradiction}`);
  console.log(`  ${w.opportunity}`);
  process.exit(0);
}

if(cmd === "peek" || cmd === "claim"){
  const w = refreshWatchers(now);
  const c = DR.claim(log, store, { now, dryRun: cmd === "peek", max: +(process.argv[3] || 25) });
  fs.writeFileSync(BRIEF, DR.briefMarkdown(c));
  fs.writeFileSync(CLAIMF, JSON.stringify({ at: now, mode: cmd, claimed: c.claimed || [],
                                            summary: c.summary }, null, 1));
  console.log(`${w.added} new event(s) from the watchers`);
  console.log(c.summary);
  console.log(`brief → ${BRIEF}`);
  if(c.empty) console.log("NOTHING TO REASON ABOUT — this is a healthy state, not a failure.");
  process.exit(0);
}

if(cmd === "apply"){
  const file = process.argv[3];
  if(!file){ console.error("usage: drain-cli.js apply <conclusions.json>"); process.exit(2); }
  const payload = JSON.parse(fs.readFileSync(file, "utf8"));
  const ids = payload.eventIds
    || (fs.existsSync(CLAIMF) ? JSON.parse(fs.readFileSync(CLAIMF,"utf8")).claimed : []);
  const r = DR.apply(log, store, payload.updates || [], ids, { now });
  console.log(r.summary);
  r.written.forEach(w => console.log(`  ${w.key}: ${w.confidence}`));
  const f = store.freshness(now, log.unprocessedCount());
  console.log(`queue now ${log.unprocessedCount()} unprocessed · ${f.state}`);
  process.exit(0);
}

console.error("unknown command: " + cmd);
process.exit(2);
