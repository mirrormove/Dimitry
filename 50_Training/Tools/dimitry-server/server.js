/* ============================================================
   DIMITRY LOCAL SERVER  ·  Phase 0
   Zero dependencies — pure Node built-ins. No `npm install`.
   Serves the dashboard as an installable app + exposes the vault
   over a small sandboxed API so your phone can reach it via Tailscale.

   Run:  node server.js
   Then: http://localhost:8848  (PC)  ·  Tailscale URL (phone)
   ============================================================ */
const http = require("http");
const https = require("https");
const fs   = require("fs");
const path = require("path");
const url  = require("url");
const { BeliefStore } = require("./belief-store.js");   // v4 Phase 0
const { EventLog }    = require("./watchers/event-log.js");
const CONTRA = require("./watchers/contradiction.js");    // v4 Step 4  — PINNED
const OPP    = require("./watchers/opportunity.js");      // v4 Step 4  — PINNED
const MACRO  = require("./watchers/macro.js");            // v4 Step 4b — PINNED (regime/calendar/correlation)
const CONFLU = require("./watchers/confluence.js");       // v4 Step 5 — PINNED (correlation/confluence)
const WM     = require("./watchers/watch-manager.js");    // v4 Step 6 — attention allocation
const { runWorker } = require("./rules/worker.js");       // closing the loop — Tier-0 auto-disposition + Tier-1 hook
const ANALYSIS = require("./analysis-source.js");         // single source of truth for setups (web ⇄ mobile parity)
const JP       = require("./journal-parse.js");           // free text → structured, linked journal facts

// ---- config ------------------------------------------------
const PORT       = process.env.PORT || 8848;
const HERE       = __dirname;
const VAULT_ROOT = path.resolve(HERE, "..", "..", "..");        // → Trading/
const DASHBOARD  = path.resolve(HERE, "..", "Dimitry Dashboard.html");
let   TOKEN      = process.env.DIMITRY_TOKEN || "";              // optional shared secret
const BELIEFS    = path.resolve(HERE, "..", "beliefs.json");     // machine state ("RAM")
const beliefs    = new BeliefStore(BELIEFS).load();
const EVENTS_F   = path.resolve(HERE, "..", "events.ndjson");
const eventLog   = new EventLog(EVENTS_F);

/* ---- v4 Step 4: the two BELIEF-BASED watchers -----------------
   Both are PINNED (spec §7.1) and need no market detection, so they run
   in the daemon today regardless of the parked price detectors.

   K20 · DE-DUPLICATION. These watch a SLOW-MOVING store — a belief decays or
   conflicts once, not every tick. Re-emitting is its own noise (it produced the
   457-event pile of 2026-07-28). So dedup by (type|affects|DAY), and PERSIST the
   seen-keys across restarts — the in-memory-only version re-emitted the whole
   book every time the daemon (or an endpoint smoke-test) booted. Keys older than
   48h are pruned so a genuinely-unresolved fact re-surfaces the next day. */
const SEEN_F = path.resolve(HERE, "..", "watcher-seen.json");
let __wTimer = null, __seen = new Map();     // key → firstSeen ts
let __attnPrior = null, __prices = {}, __recent = {};   // attention plan + live price + recent candles

/* K42 — live market data into the daemon so the Opportunity watcher's ENTRY_WINDOW /
   CONTINUATION_WINDOW become real-time states, not static setup text. Zero-dep Binance
   klines for crypto assets; FX / metals / indices have no free feed here, so they stay
   'armed' (honest — no fabricated price). */
function httpsJson(u){ return new Promise((res,rej)=>{ const rq=https.get(u,{timeout:8000},r=>{
    let d=""; r.on("data",c=>d+=c); r.on("end",()=>{ try{res(JSON.parse(d));}catch(e){rej(e);} }); });
  rq.on("error",rej); rq.on("timeout",()=>{rq.destroy();rej(new Error("timeout"));}); }); }
async function refreshPrices(){
  try{ beliefs.load();
    const assets=[...new Set(beliefs.all(null,Date.now()).map(b=>b.asset).filter(Boolean))]
      .filter(a=>a==="BTCUSDT" || /USDT$/.test(a) || /^(BTC|ETH)/.test(a));   // crypto only (has a Binance symbol)
    for(const a of assets){ try{
      const kl=await httpsJson(`https://api.binance.com/api/v3/klines?symbol=${a}&interval=15m&limit=8`);
      if(Array.isArray(kl) && kl.length){ __recent[a]=kl.map(k=>({h:+k[2],l:+k[3],c:+k[4]})); __prices[a]=+kl[kl.length-1][4]; }
    }catch(e){} }
  }catch(e){}
}
setTimeout(refreshPrices, 1500);
setInterval(refreshPrices, 60000);           // refresh live price every 60s

/* Non-crypto continuous feed (metals · indices · FX) via Yahoo Finance chart API —
   the same shape (price + recent candles) so the Opportunity watcher's live windows
   work for every asset, not just BTC. Unblocks K29 (FX) and the new index/metal assets. */
const YAHOO_SYM = { XAGUSD:"SI=F", US500:"^GSPC", US100:"^NDX", XAUUSD:"GC=F",
                    EURUSD:"EURUSD=X", GBPUSD:"GBPUSD=X", USDJPY:"USDJPY=X" };
async function refreshYahoo(){
  for(const [asset, sym] of Object.entries(YAHOO_SYM)){
    try{
      const j = await httpsJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=15m&range=1d`);
      const r = j && j.chart && j.chart.result && j.chart.result[0];
      const q = r && r.indicators && r.indicators.quote && r.indicators.quote[0];
      if(r && q && Array.isArray(r.timestamp)){
        const n=r.timestamp.length, bars=[];
        for(let i=Math.max(0,n-8); i<n; i++){ if(q.close[i]!=null) bars.push({ h:q.high[i], l:q.low[i], c:q.close[i] }); }
        if(bars.length){ __recent[asset]=bars; __prices[asset]=(r.meta && r.meta.regularMarketPrice) || bars[bars.length-1].c; }
      }
    }catch(e){}
  }
}
setTimeout(refreshYahoo, 2500);
setInterval(refreshYahoo, 60000);
(function loadSeen(){ try{
  const raw = JSON.parse(fs.readFileSync(SEEN_F,"utf8"));
  for(const [k,t] of Object.entries(raw)) __seen.set(k, t);
}catch(e){} })();
function saveSeen(){
  const cutoff = Date.now() - 48*36e5;
  for(const [k,t] of __seen) if(t < cutoff) __seen.delete(k);   // prune → unresolved facts re-surface next day
  try{ fs.writeFileSync(SEEN_F, JSON.stringify(Object.fromEntries(__seen))); }catch(e){}
}
function runBeliefWatchers(){
  try{
    beliefs.load();
    const now = Date.now();
    const c = CONTRA.run(beliefs, { now });
    /* 4b: the macro watcher decides whether a high-impact event is live; that boolean
       scopes the Opportunity watcher's execution (WATCH-ONLY through a print) instead of
       hiding the move. Run macro first so its newsWindow feeds opportunity this same tick. */
    const m = MACRO.run(beliefs, { now });
    const newsWindow = MACRO.newsWindowNow(beliefs, now);
    const o = OPP.run(beliefs, { now, newsWindow, prices:__prices, recent:__recent });
    /* Step 5: composite conviction across INDEPENDENT lenses (structure/macro/flow/…),
       collapsing internal echo (a setup agreeing with its own bias). */
    const cf = CONFLU.run(beliefs, { now, events: eventLog.recent ? eventLog.recent(500) : undefined });
    /* Step 6: allocate the attention budget; emit wake/hibernate shifts vs the prior plan. */
    const wm = WM.run(beliefs, { now, prior: __attnPrior, prices: __prices });
    __attnPrior = wm.plan;
    try{ fs.writeFileSync(path.resolve(HERE,"..","attention.json"), JSON.stringify({ at:now, plan:wm.plan },null,2)); }catch(e){}
    const fresh = [];
    for(const e of c.events.concat(m.events).concat(o.events).concat(cf.events).concat(wm.events)){
      const day = new Date(e.t||now).toISOString().slice(0,10);   // DAY bucket (was hour → 24× the noise)
      const k = `${e.type}|${(e.affects||[]).join(",")}|${day}`;
      if(__seen.has(k)) continue;                                 // already emitted today, incl. before this restart
      __seen.set(k, now);
      fresh.push(e);
    }
    saveSeen();
    if(fresh.length) eventLog.append(fresh);
    return { contradiction:CONTRA.summarise(c), macro:MACRO.summarise(m), opportunity:OPP.summarise(o),
             confluence:CONFLU.summarise(cf), newsWindow, emitted:fresh.length, seenKeys:__seen.size, events:fresh };
  }catch(e){ return { error:String(e.message||e) }; }
}
setTimeout(runBeliefWatchers, 3000);
__wTimer = setInterval(runBeliefWatchers, 5*60*1000);   // every 5 min

/* Closing the loop AUTONOMOUSLY. The Tier-0 worker settles the mechanical bulk
   (decay re-affirm, dismiss scope flags, guard a correlation) with no model, so
   the queue does not wait for the human 07:30 drain and cannot pile up. A
   fallback model can be attached (opts.reasoner) for the escalated remainder;
   until then those stay awaiting the primary agent. */
let __workerBusy = false;
async function runAutoWorker(){
  if(__workerBusy) return; __workerBusy = true;
  try{ beliefs.load(); return await runWorker(eventLog, beliefs, { now:Date.now() /*, reasoner: <fallback model> */ }); }
  catch(e){ return { error:String(e.message||e) }; }
  finally{ __workerBusy = false; }
}
setTimeout(runAutoWorker, 20000);                        // shortly after the first watch pass
setInterval(runAutoWorker, 15*60*1000);                  // every 15 min — deterministic, safe to repeat

// ---- helpers -----------------------------------------------
const MIME = { ".html":"text/html", ".js":"text/javascript", ".css":"text/css",
  ".json":"application/json", ".webmanifest":"application/manifest+json",
  ".svg":"image/svg+xml", ".png":"image/png", ".md":"text/markdown", ".ico":"image/x-icon" };

function send(res, code, body, type){
  res.writeHead(code, { "Content-Type": type || "text/plain; charset=utf-8",
    "Access-Control-Allow-Origin":"*", "Access-Control-Allow-Headers":"*",
    "Access-Control-Allow-Methods":"GET,PUT,POST,OPTIONS" });
  res.end(body);
}
/* keep every vault path INSIDE the vault — no `..` escape, ever */
function safeVaultPath(rel){
  const p = path.resolve(VAULT_ROOT, "." + path.sep + (rel||"").replace(/^[/\\]+/,""));
  if(!p.startsWith(VAULT_ROOT)) return null;
  return p;
}
/* ---- multi-user access (opt-in) ---------------------------------------------
   users.json (gitignored) = [{ "token":"…", "name":"izuosi", "role":"owner" }, …]
   role: owner | full (can log) | view (read-only). If the file is absent the
   server stays OPEN on the tailnet exactly as before — this is additive. */
const USERS_F = path.resolve(HERE, "users.json");
let __users = null, __usersMtime = 0;
function loadUsers(){
  try{ const st = fs.statSync(USERS_F); if(st.mtimeMs === __usersMtime) return __users;
    __users = JSON.parse(fs.readFileSync(USERS_F, "utf8")); __usersMtime = st.mtimeMs;
  }catch(e){ __users = null; }
  return __users;
}
function tokenOf(req){
  const q = url.parse(req.url, true).query;
  return q.token || req.headers["x-dimitry-token"] || "";
}
/* resolve the caller → {name, role} or null */
function whoIs(req){
  const users = loadUsers();
  if(Array.isArray(users) && users.length){
    const t = tokenOf(req); return users.find(u => u.token && u.token === t) || null;
  }
  if(TOKEN){ return tokenOf(req) === TOKEN ? { name:"owner", role:"owner" } : null; }
  return { name:"owner", role:"owner" };   // fully open (single-user default)
}
function authed(req){ return !!whoIs(req); }
/* write actions (log a trade / journal) require full or owner; viewers are read-only */
function canWrite(req){ const u = whoIs(req); return !!u && (u.role === "owner" || u.role === "full"); }


/* Load whatever kline cache exists → { asset: { tf: candles } }.
   The rule engine degrades honestly: no cache = nothing checkable, and
   /api/rules says so rather than reporting "nothing fired". */
function loadKlineCache(){
  const dir = path.resolve(HERE, "..", "klines");
  const out = {};
  try{
    for(const f of fs.readdirSync(dir)){
      if(!f.endsWith(".json")) continue;
      const s = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if(!s.candles || !s.candles.length) continue;
      if(/SYNTHETIC/i.test(s.source||"")) continue;
      (out[s.asset] = out[s.asset] || {})[s.tf] = s.candles;
    }
  }catch(e){}
  return out;
}

// ---- the dashboard, with the PWA bits injected on the fly ----
function serveDashboard(res){
  fs.readFile(DASHBOARD, "utf8", (e, html) => {
    if(e){ return send(res, 500, "Dashboard not found at "+DASHBOARD); }
    const inject = `<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#080b0e">
<link rel="apple-touch-icon" href="/icon.svg">
<script>if("serviceWorker" in navigator){navigator.serviceWorker.register("/sw.js").catch(()=>{});}
window.DIMITRY_SERVER=true;
window.DIMITRY_TOKEN=${JSON.stringify(TOKEN||"")};</script>`;
    html = html.replace(/<head>/i, "<head>\n"+inject);
    send(res, 200, html, "text/html; charset=utf-8");
  });
}

// ---- request router ----------------------------------------
const server = http.createServer((req, res) => {
  const u = url.parse(req.url, true);
  const p = decodeURIComponent(u.pathname);

  if(req.method === "OPTIONS") return send(res, 204, "");

  // app entry
  if(p === "/" || p === "/index.html") return serveDashboard(res);

  // mobile app — served same-origin so the phone reaches /api/* with no CORS/mixed-content
  if(p === "/m" || p === "/mobile"){
    const f = path.resolve(HERE, "..", "Dimitry Mobile.html");
    return fs.readFile(f, "utf8", (e, data) => {
      if(e) return send(res, 404, "mobile app not found");
      /* never let a stale copy sit in the phone/SW cache — the app is tiny and
         same-origin, so always ship the current build (K: "I reloaded, still old") */
      let build = "";
      try{ build = "b"+String(Math.floor(fs.statSync(f).mtimeMs)).slice(-6); }catch(_){}
      data = data.replace("</body>", `<script>window.DIMITRY_BUILD=${JSON.stringify(build)};
try{var _b=document.getElementById("statusText");if(_b)_b.textContent="SYSTEM ONLINE · "+${JSON.stringify(build)};}catch(e){}
if("serviceWorker" in navigator){navigator.serviceWorker.getRegistrations().then(rs=>rs.forEach(r=>r.unregister())).catch(()=>{});}
</script></body>`);
      res.writeHead(200, { "Content-Type":"text/html; charset=utf-8",
        "Cache-Control":"no-store, no-cache, must-revalidate", "Pragma":"no-cache", "Expires":"0",
        "Access-Control-Allow-Origin":"*" });
      res.end(data);
    });
  }

  // PWA + static assets from this folder
  if(["/manifest.webmanifest","/sw.js","/icon.svg"].includes(p)){
    const f = path.join(HERE, p.slice(1));
    return fs.readFile(f, (e, data) =>
      e ? send(res, 404, "not found") : send(res, 200, data, MIME[path.extname(f)]));
  }

  // who am I — the app uses this to hide write actions for view-only users
  if(p === "/api/whoami"){
    const u = whoIs(req);
    if(!u) return send(res, 401, JSON.stringify({ ok:false }), "application/json");
    return send(res, 200, JSON.stringify({ ok:true, name:u.name, role:u.role,
      canWrite:(u.role==="owner"||u.role==="full") }), "application/json");
  }

  // health / freshness — the app can ask "is the server alive?"
  if(p === "/api/health"){
    let fresh=null;
    try{ fresh = beliefs.load().freshness(Date.now(), eventLog.unprocessedCount()); }catch(e){}
    return send(res, 200, JSON.stringify({
      ok:true, time:new Date().toISOString(), vault:VAULT_ROOT,
      protected: !!TOKEN, beliefs:fresh }), "application/json");
  }

  /* ---- v4 rule engine (T1) --------------------------------
     GET /api/rules            → what the machine IS watching, and what it is NOT
     GET /api/rules?run=1      → evaluate now (needs a kline cache present)     */
  if(p === "/api/rules"){
    if(!authed(req)) return send(res, 401, "unauthorized");
    try{
      const { parse } = require("./rules/invalidator.js");
      const { run: runRules, summarise } = require("./rules/engine.js");
      beliefs.load();
      const now = Date.now();
      const watched = [], notWatched = [];
      for(const b of beliefs.all(null, now)){
        if(!b.invalidator || b.class === "doctrine") continue;
        const pr = parse(b.invalidator, b.asset);
        (pr.parsed ? watched : notWatched).push({
          key:b.key, claim:b.claim, invalidator:b.invalidator, asset:b.asset,
          clauses: pr.parsed ? pr.clauses.map(c=>({ tf:c.tf, dir:c.dir, level:c.level,
                     volMult:c.volMult||null, hold:c.hold })) : null,
          reason: pr.parsed ? null : pr.unparsed
        });
      }
      let ran = null;
      if(u.query.run){
        const candles = loadKlineCache();
        ran = runRules(beliefs, candles, { now, dryRun: !u.query.commit });
        if(u.query.commit && ran.updates.length) beliefs.save();
        ran.summary = summarise(ran);
        ran.dryRun = !u.query.commit;
      }
      return send(res, 200, JSON.stringify({ watched, notWatched, ran }), "application/json");
    }catch(e){ return send(res, 500, "rule engine error: "+e.message); }
  }

  /* ---- v4 Brain-3 drain (Step 7) --------------------------
     GET  /api/drain            → the reasoning brief (claims the queue)
     GET  /api/drain?peek=1     → same, WITHOUT claiming
     GET  /api/drain?md=1       → brief as markdown, for an agent run
     POST /api/drain            → {updates:[…], eventIds:[…]} — record conclusions */
  if(p === "/api/drain"){
    if(!authed(req)) return send(res, 401, "unauthorized");
    const DR = require("./rules/drain.js");
    if(req.method === "GET"){
      try{
        beliefs.load();
        const c = DR.claim(eventLog, beliefs, { now:Date.now(), dryRun: !!u.query.peek,
                                                max: +(u.query.max||25) });
        if(u.query.md) return send(res, 200, DR.briefMarkdown(c), "text/markdown; charset=utf-8");
        return send(res, 200, JSON.stringify(c), "application/json");
      }catch(e){ return send(res, 500, "drain error: "+e.message); }
    }
    if(req.method === "POST"){
      let body="";
      req.on("data", d=>{ body+=d; if(body.length>2e6) req.destroy(); });
      req.on("end", ()=>{
        try{
          const { updates, eventIds } = JSON.parse(body||"{}");
          beliefs.load();
          const r = DR.apply(eventLog, beliefs, updates||[], eventIds||[], { now:Date.now() });
          send(res, 200, JSON.stringify(r), "application/json");
        }catch(e){ send(res, 400, "apply failed: "+e.message); }
      });
      return;
    }
    return send(res, 405, "method not allowed");
  }

  /* ---- v4 belief watchers (Step 4) ------------------------
     GET /api/watch        → last run summary + the event log's state
     GET /api/watch?run=1  → run them now                              */
  if(p === "/api/watch"){
    if(!authed(req)) return send(res, 401, "unauthorized");
    try{
      const ran = u.query.run ? runBeliefWatchers() : null;
      return send(res, 200, JSON.stringify({
        ran, log: eventLog.stats(), unprocessed: eventLog.unprocessedCount()
      }), "application/json");
    }catch(e){ return send(res, 500, "watch error: "+e.message); }
  }

  /* ---- journal / upload intake ---------------------------
     POST /api/journal {name, mime, b64|text, note, kind} → drop a trade upload
       into _attachments/_inbox for the next processing pass to extract & log.
     GET  /api/journal → the recent upload queue (for the app's "recent" list). */
  if(p === "/api/journal"){
    if(!authed(req)) return send(res, 401, "unauthorized");
    const INBOX = path.resolve(VAULT_ROOT, "_attachments", "_inbox");
    const QUEUE = path.resolve(INBOX, "_journal-queue.ndjson");
    try{ fs.mkdirSync(INBOX, { recursive:true }); }catch(e){}
    if(req.method === "GET"){
      let rows=[]; try{ rows=fs.readFileSync(QUEUE,"utf8").trim().split("\n").filter(Boolean).map(JSON.parse); }catch(e){}
      /* parse on read too, so entries logged before the parser existed still
         display structured (and a parser improvement retro-applies). */
      rows = rows.map(r => r.parsed ? r : Object.assign({}, r, { parsed: JP.parseEntry(r.note||"", r.kind) }));
      rows = rows.map(r => Object.assign({}, r, { summary: JP.summarise(r.parsed) }));
      const recent = rows.slice(-40).reverse();
      if(u.query.digest) return send(res, 200, JSON.stringify({ entries:recent, digest:JP.digest(rows) }, null, 2), "application/json");
      return send(res, 200, JSON.stringify(recent), "application/json");
    }
    if(req.method === "POST"){
      if(!canWrite(req)) return send(res, 403, "read-only user — logging is disabled for this access token");
      const who = (whoIs(req)||{}).name || "owner";
      let body=""; req.on("data", d=>{ body+=d; if(body.length>9e6) req.destroy(); });
      req.on("end", ()=>{ try{
        const j=JSON.parse(body||"{}");
        const safe=String(j.name||"upload").replace(/[^\w.\-]+/g,"_").slice(0,60)||"upload";
        const stamp=new Date().toISOString().replace(/[:.]/g,"-").slice(0,19);
        const fname=`${stamp}__${safe}`, dest=path.join(INBOX, fname);
        if(j.b64) fs.writeFileSync(dest, Buffer.from(String(j.b64).replace(/^data:[^,]+,/,""),"base64"));
        else if(j.text!=null) fs.writeFileSync(dest, String(j.text), "utf8");
        else if(!j.note) return send(res, 400, "no file content or note");
        /* parse the free text into structured, linkable facts at write time */
        const parsed = JP.parseEntry(j.note||"", j.kind);
        const rec={ at:Date.now(), user:who, file:(j.b64||j.text!=null)?fname:null, original:j.name||null,
                    mime:j.mime||null, note:j.note||null, kind:parsed.kind||j.kind||"trade",
                    setupKey:j.setupKey||parsed.setupRef||null, parsed, processed:false };
        fs.appendFileSync(QUEUE, JSON.stringify(rec)+"\n");
        return send(res, 200, JSON.stringify({ ok:true, file:rec.file }), "application/json");
      }catch(e){ return send(res, 400, "journal error: "+e.message); } });
      return;
    }
    return send(res, 405, "method not allowed");
  }

  /* ---- execution intents (the setup→execution→outcome bridge) ----
     POST /api/execution {setupKey, asset, dir, intent:executed|skipped, window,
       params:{entry,size,stop}, note} → the consolidated intent record the
       reconciliation pass links to the setup and, later, the broker fill.
     GET  /api/execution → recent intents (for the app to show status). */
  if(p === "/api/execution"){
    if(!authed(req)) return send(res, 401, "unauthorized");
    const LEDGER = path.resolve(HERE, "..", "executions.ndjson");
    if(req.method === "GET"){
      let rows=[]; try{ rows=fs.readFileSync(LEDGER,"utf8").trim().split("\n").filter(Boolean).map(JSON.parse); }catch(e){}
      return send(res, 200, JSON.stringify(rows.slice(-60).reverse()), "application/json");
    }
    if(req.method === "POST"){
      if(!canWrite(req)) return send(res, 403, "read-only user — execution logging is disabled for this access token");
      const who = (whoIs(req)||{}).name || "owner";
      let body=""; req.on("data", d=>{ body+=d; if(body.length>1e5) req.destroy(); });
      req.on("end", ()=>{ try{
        const j=JSON.parse(body||"{}");
        if(!j.setupKey && !j.asset) return send(res, 400, "need setupKey or asset");
        const rec={ at:Date.now(), user:who, setupKey:j.setupKey||null, asset:j.asset||null, dir:j.dir||null,
          intent:(j.intent==="executed"?"executed":"skipped"), window:j.window||null,
          params:(j.intent==="executed"?(j.params||null):null), note:j.note||null,
          source:"app", outcome:null, disciplineScore:null, leakTags:[], reconciled:false };
        fs.appendFileSync(LEDGER, JSON.stringify(rec)+"\n");
        return send(res, 200, JSON.stringify({ ok:true, intent:rec.intent }), "application/json");
      }catch(e){ return send(res, 400, "execution error: "+e.message); } });
      return;
    }
    return send(res, 405, "method not allowed");
  }

  /* ---- live opportunity state (K42) ----------------------
     GET /api/opportunity → per-setup LIVE stage (armed/at-zone/running/continuation)
     evaluated against the current price + recent candles, for the apps to reflect. */
  if(p === "/api/opportunity"){
    if(!authed(req)) return send(res, 401, "unauthorized");
    try{
      beliefs.load();
      const r = OPP.run(beliefs, { now:Date.now(), newsWindow: MACRO.newsWindowNow(beliefs, Date.now()),
                                   prices:__prices, recent:__recent });
      const stages = r.scored.map(x => ({ key:x.s.key, asset:x.s.asset, dir:x.p.dir,
        stage:x.stage, entryOpen:x.entryOpen, price:(x.price!=null?x.price:null),
        zone:x.p.zone, stop:x.p.stop, finalTarget:x.p.finalTarget, campaignRR:x.rr, viable:x.viable }));
      return send(res, 200, JSON.stringify({ scope:r.scope, prices:__prices, stages,
        events:r.events.filter(e=>/ENTRY_WINDOW|CONTINUATION_WINDOW|PRIMARY_MOVE/.test(e.type)) }, null, 2), "application/json");
    }catch(e){ return send(res, 500, "opportunity error: "+e.message); }
  }

  /* ---- SINGLE SOURCE OF TRUTH: setups served to BOTH web & mobile --------
     GET /api/analysis → the web's authored VAULT.analysis, extracted live and
     enriched per-setup with { stage, entryOpen, price, proximityPct, session,
     generatedAt, armedFor, marketOpen }. `primaries` = one per asset ranked by
     execution proximity; `armed` = open-market primaries actionable right now.
     Web renders the inline literal; mobile renders this — same object, no drift. */
  if(p === "/api/analysis"){
    if(!authed(req)) return send(res, 401, "unauthorized");
    try{
      const V = ANALYSIS.getVault();
      const now = Date.now();
      const priceKey = id => ({ BTC:"BTCUSDT" }[id] || id);
      const isCrypto = k => k==="BTCUSDT" || /USDT$/.test(k) || /^(BTC|ETH)/.test(k);
      const fxClosed = d => { const day=d.getUTCDay(), h=d.getUTCHours();
        return day===6 || (day===0 && h<21) || (day===5 && h>=21); };
      const marketOpenNow = k => isCrypto(k) ? true : !fxClosed(new Date(now));
      const sessionOf = ts => { if(!ts) return null; const h=new Date(ts).getUTCHours();
        return (h>=12&&h<16)?"London–NY overlap":(h>=7&&h<12)?"London":(h>=16&&h<21)?"New York":(h>=21||h<0)?"Sydney":"Asia"; };
      const humanDur = ms => { if(ms==null||ms<0) return null; const m=Math.floor(ms/60000),h=Math.floor(m/60),d=Math.floor(h/24);
        return d>0?`${d}d ${h%24}h`:h>0?`${h}h ${m%60}m`:`${m}m`; };
      const stageRank = { "at-zone":0, "continuation":1, "running":2, "armed":3 };

      const assets = V.assets.map(a => {
        const an = a.analysis, pk = priceKey(a.id);
        const price = (__prices[pk]!=null ? __prices[pk] : null);
        const recent = __recent[pk] || null;
        const open = marketOpenNow(pk);
        const base = { id:a.id, name:a.name, cls:a.cls, dp:a.dp, feed:a.feed, line:a.line, coverage:a.coverage,
          marketOpen:open, price, recent:(Array.isArray(recent)?recent.slice(-12):[]) };
        if(!an || !Array.isArray(an.setups)) return Object.assign(base, { hasAnalysis:false, setups:[] });
        const setups = an.setups.map((s, idx) => {
          const dir = String(s.dir||"").toLowerCase();
          const zone = Array.isArray(s.zone) ? s.zone : null;
          const live = OPP.stageOf({ dir, zone }, price, recent);
          let proximityPct = null;
          if(zone && price!=null){ const [lo,hi]=zone;
            proximityPct = live.entryOpen ? 0 : Math.min(Math.abs(price-lo),Math.abs(price-hi))/price; }
          const estTs = s.established ? Date.parse(s.established) : null;
          /* LIVE conviction — fluid: starts at the authored base, then reacts to where
             price is RIGHT NOW. Rises as price nears the zone, jumps in-zone, decays if
             it runs past. Recomputed every request, so it moves in real time. */
          const base = (typeof s.baseProb === "number") ? s.baseProb : 0.5;
          let lc = base + 0.05;                                   // slight upward sensitivity
          if(live.stage === "at-zone")           lc += 0.16;
          else if(live.stage === "continuation") lc += 0.11;
          else if(live.stage === "running")      lc -= 0.14;
          else if(proximityPct != null)          lc += 0.14 * Math.max(0, 1 - proximityPct/0.03);
          if(!open) lc = base;                                    // closed market → static base
          lc = Math.max(0.05, Math.min(0.95, lc));
          const convGrade = lc>=0.75?"A":lc>=0.62?"B":lc>=0.50?"C":"D";
          const convTrend = lc>base+0.02?"up":lc<base-0.02?"down":"flat";
          return Object.assign({}, s, { dir, idx, setupKey:a.id+"#"+idx, asset:a.id, assetName:a.name,
            isPrimary: /PRIMARY/i.test(s.name||"") || idx===0,
            stage:live.stage, entryOpen:live.entryOpen, price, proximityPct,
            liveConviction:lc, convGrade, convTrend,
            session:sessionOf(estTs), generatedAt:estTs,
            armedForMs: estTs?now-estTs:null, armedFor: humanDur(estTs?now-estTs:null),
            marketOpen:open });
        });
        const primary = setups.find(s=>/PRIMARY/i.test(s.name||"")) ||
                        setups.find(s=>s.tier==="important") || setups[0] || null;
        return Object.assign(base, { hasAnalysis:true, thesis:an.thesis||null,
          ladderMin:an.ladderMin, ladderMax:an.ladderMax, levels:an.levels||[],
          macroChips:an.macroChips||[], mtf:an.mtf||[], keyPivot:an.keyPivot,
          bullTriggerLevel:an.bullTriggerLevel, setups, primaryKey: primary?primary.setupKey:null });
      });

      const primaries = assets.filter(a=>a.hasAnalysis && a.primaryKey)
        .map(a => { const s = a.setups.find(x=>x.setupKey===a.primaryKey);
                    return Object.assign({}, s, { asset:a.id, assetName:a.name }); })
        /* MARKET-CENTRIC ranking: open markets first, then by LIVE conviction across
           every asset (not BTC by default) — the strongest live read leads. */
        .sort((x,y) =>
          (y.marketOpen-x.marketOpen) ||
          ((y.liveConviction||0)-(x.liveConviction||0)) ||
          ((x.proximityPct==null?9:x.proximityPct)-(y.proximityPct==null?9:y.proximityPct)) );

      /* ARMED = genuinely AT a trigger on an open market (in-zone or a live pullback).
         This is what the web calls an ACT window — anything merely "approaching" is a
         watch, not a trade, so the mobile verdict matches the web's NO-TRADE read. */
      const armed = primaries.filter(s => s.marketOpen && (s.entryOpen || s.stage==="continuation"));
      const approaching = primaries.filter(s => s.marketOpen && !s.entryOpen && s.stage!=="continuation"
        && s.proximityPct!=null && s.proximityPct<=0.03);
      const verdict = armed.length
        ? { state:"act", asset:armed[0].asset, dir:armed[0].dir, setupKey:armed[0].setupKey,
            text:`ACT · ${armed[0].asset} ${(armed[0].dir||"").toUpperCase()} at the trigger` }
        : { state:"no-trade", setupKey:(approaching[0]||{}).setupKey||null, asset:(approaching[0]||{}).asset||null,
            text: approaching.length ? `NO TRADE · watching ${approaching[0].asset} into its zone`
                                      : "NO TRADE · protect capital" };

      return send(res, 200, JSON.stringify({ updated:V.updated, now, verdict,
        story:V.story||null, scorecard:V.scorecard||null, positions:V.positions||null,
        catalysts:V.catalysts||null, assets, primaries, armed, approaching }, null, 2), "application/json");
    }catch(e){ return send(res, 500, "analysis error: "+e.message); }
  }

  /* ---- reconciliation (Step 3: your leaks, measured) -----
     GET /api/reconcile        → the latest reconciliation report (records + leaks)
     GET /api/reconcile?run=1  → recompute from executions.ndjson + fills.ndjson + beliefs */
  if(p === "/api/reconcile"){
    if(!authed(req)) return send(res, 401, "unauthorized");
    try{
      const RC = path.resolve(HERE, "..", "reconciliation.json");
      if(u.query.run || !fs.existsSync(RC)){
        const { reconcile, setupsFromBeliefs } = require("./rules/reconcile.js");
        const read = f => { try{ return fs.readFileSync(path.resolve(HERE,"..",f),"utf8").trim().split("\n").filter(Boolean).map(JSON.parse); }catch(e){ return []; } };
        beliefs.load();
        const r = reconcile(read("fills.ndjson"), setupsFromBeliefs(beliefs.all(null,Date.now())), read("executions.ndjson"), {});
        fs.writeFileSync(RC, JSON.stringify(r,null,2));
        fs.writeFileSync(path.resolve(HERE,"..","process-leaks.json"),
          JSON.stringify({ updated:Date.now(), fedBy:["reconcile"], impulsivity:r.leaks.impulsivity, timidity:r.leaks.timidity },null,2));
      }
      return send(res, 200, fs.readFileSync(RC,"utf8"), "application/json");
    }catch(e){ return send(res, 500, "reconcile error: "+e.message); }
  }

  /* ---- v4 base rates (Step 8: the calibration loop) ------
     GET /api/base-rates        → the measured, shrinkage-calibrated artifact
     GET /api/base-rates?run=1  → recompute from the scorecard + adjudication first */
  if(p === "/api/base-rates"){
    if(!authed(req)) return send(res, 401, "unauthorized");
    try{
      const BR_F = path.resolve(HERE, "..", "base-rates.json");
      if(u.query.run || !fs.existsSync(BR_F)){
        delete require.cache[require.resolve("./calibration/scorecard-data.js")];
        const { computeBaseRates } = require("./calibration/base-rates.js");
        const scorecard = require("./calibration/scorecard-data.js");
        let adj = null;
        try{ adj = JSON.parse(fs.readFileSync(path.resolve(HERE,"..","adjudication.json"),"utf8")); }catch(e){}
        fs.writeFileSync(BR_F, JSON.stringify(computeBaseRates(scorecard, adj), null, 2));
      }
      return send(res, 200, fs.readFileSync(BR_F, "utf8"), "application/json");
    }catch(e){ return send(res, 500, "base-rates error: "+e.message); }
  }

  /* ---- v4 watch manager (Step 6: attention allocation) ----
     GET /api/attention → the current auditable allocation plan (active/light/hibernate) */
  if(p === "/api/attention"){
    if(!authed(req)) return send(res, 401, "unauthorized");
    try{ beliefs.load(); return send(res, 200, JSON.stringify(WM.allocate(beliefs, { now:Date.now(), prices:__prices }), null, 2), "application/json"); }
    catch(e){ return send(res, 500, "attention error: "+e.message); }
  }

  /* ---- v4 worker (closing the loop) ----------------------
     GET /api/worker        → run one Tier-0 auto-disposition cycle now
     (Tier-1 fallback model attaches in code via runWorker's `reasoner`.) */
  if(p === "/api/worker"){
    if(!authed(req)) return send(res, 401, "unauthorized");
    return runAutoWorker().then(r => send(res, 200, JSON.stringify(r, null, 2), "application/json"))
                          .catch(e => send(res, 500, "worker error: "+e.message));
  }

  /* ---- v4 ascent / self-model (perpetual improvement) ----
     GET /api/ascent        → the current self-model: EQ, barriers, self-set goals
     GET /api/ascent?run=1  → advance one cycle (append a snapshot) first */
  if(p === "/api/ascent"){
    if(!authed(req)) return send(res, 401, "unauthorized");
    try{
      delete require.cache[require.resolve("./calibration/self-model-data.js")];
      const { snapshot, ascend, profitabilityFrom } = require("./calibration/ascent.js");
      const { processLeaks, efficiencyThreshold } = require("./calibration/self-model-data.js");
      const SM = path.resolve(HERE, "..", "self-model.json");
      let br=null, hist=[];
      try{ br = JSON.parse(fs.readFileSync(path.resolve(HERE,"..","base-rates.json"),"utf8")); }catch(e){}
      try{ hist = JSON.parse(fs.readFileSync(SM,"utf8")).history || []; }catch(e){}
      const snap = snapshot(br, processLeaks);
      const result = ascend(hist, snap, { now: Date.now(), profitability: profitabilityFrom(br), efficiencyThreshold });
      if(u.query.run){
        hist.push({ at:result.at, snapshot:result.snapshot, barriers:result.barriers, eq:result.eq,
                    mode:result.mode, efficiency:result.efficiency, consistencyStreak:result.consistencyStreak, profitability:result.profitability });
        fs.writeFileSync(SM, JSON.stringify({ updated:result.at, history:hist }, null, 2));
      }
      return send(res, 200, JSON.stringify(result, null, 2), "application/json");
    }catch(e){ return send(res, 500, "ascent error: "+e.message); }
  }

  /* ---- v4 belief store ------------------------------------
     GET /api/beliefs                → all current, decayed to now
     GET /api/beliefs?asset=BTCUSDT  → filtered
     GET /api/beliefs?key=X&history=1→ the supersede chain
     GET /api/beliefs?sweep=1        → T4 stubs for decayed beliefs   */
  if(p === "/api/beliefs"){
    if(!authed(req)) return send(res, 401, "unauthorized");
    if(req.method !== "GET") return send(res, 405, "method not allowed");
    try{
      beliefs.load();                                  // pick up agent-run writes
      const now = Date.now();
      let out;
      if(u.query.history && u.query.key)      out = beliefs.history(u.query.key);
      else if(u.query.sweep)                  out = beliefs.sweep(now);
      else out = { freshness: beliefs.freshness(now, eventLog.unprocessedCount()),
                   beliefs: beliefs.all({ asset:u.query.asset, class:u.query.class }, now) };
      return send(res, 200, JSON.stringify(out), "application/json");
    }catch(e){ return send(res, 500, "belief store error: "+e.message); }
  }

  // vault read/write (sandboxed)
  if(p === "/api/vault"){
    if(!authed(req)) return send(res, 401, "unauthorized");
    const target = safeVaultPath(u.query.path || "");
    if(!target) return send(res, 400, "bad path");
    if(req.method === "GET"){
      // list a directory or read a file
      fs.stat(target, (e, st) => {
        if(e) return send(res, 404, "not found");
        if(st.isDirectory()){
          fs.readdir(target, { withFileTypes:true }, (er, items) => {
            if(er) return send(res, 500, "read error");
            send(res, 200, JSON.stringify(items.map(i =>
              ({ name:i.name, dir:i.isDirectory() }))), "application/json");
          });
        } else {
          fs.readFile(target, (er, data) =>
            er ? send(res, 500, "read error") : send(res, 200, data, MIME[path.extname(target)]||"text/plain"));
        }
      });
    } else if(req.method === "PUT" || req.method === "POST"){
      let body = "";
      req.on("data", c => { body += c; if(body.length > 8e6) req.destroy(); });
      req.on("end", () => {
        fs.mkdir(path.dirname(target), { recursive:true }, () => {
          fs.writeFile(target, body, e =>
            e ? send(res, 500, "write error") : send(res, 200, JSON.stringify({ ok:true, bytes:body.length }), "application/json"));
        });
      });
    } else send(res, 405, "method not allowed");
    return;
  }

  send(res, 404, "not found");
});

server.listen(PORT, () => {
  console.log(`\n  DIMITRY server running`);
  console.log(`  ├─ local  : http://localhost:${PORT}`);
  console.log(`  ├─ vault  : ${VAULT_ROOT}`);
  console.log(`  ├─ auth   : ${TOKEN ? "token required" : "open on this network"}`);
  console.log(`  └─ phone  : expose with  tailscale serve https / http://localhost:${PORT}\n`);
});
