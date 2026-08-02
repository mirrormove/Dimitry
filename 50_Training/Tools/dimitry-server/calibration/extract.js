/* ============================================================
   DIMITRY · GROUND-TRUTH EXTRACTOR      Vault Intelligence v4
   Zero dependencies.

   Builds the PERMANENT CALIBRATION BENCHMARK from how the operator
   has actually analysed markets — not from the watchers' own output.

   Sources
     40_Reasoning/Analyses/*.md      → labelled CONCLUSIONS (with context)
     30_Trading/Reviews/Setup Scorecard.md → OUTCOMES
     calibration/labelled-events.js  → labelled EVENTS (curated, hand-verified)

   Design rule (operator, 2026-07-27):
     "Ground truth should preserve context, not just outcomes...
      I don't just want correct/incorrect; I want to know WHY."
   So every record carries regime, session, timeframes, evidence and
   invalidation — not merely a win/loss flag.

   Run:  node calibration/extract.js
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT     = path.resolve(__dirname, "..", "..", "..", "..");      // → Trading/
const ANALYSES = path.join(ROOT, "40_Reasoning", "Analyses");
const SCORECARD= path.join(ROOT, "30_Trading", "Reviews", "Setup Scorecard.md");
const OUT      = path.resolve(__dirname, "..", "..", "calibration.json");

/* ---------- helpers ---------------------------------------- */
const clean = s => String(s==null?"":s).replace(/\*\*/g,"").replace(/[❌✅⚠⭐◉]/g,"").trim();
const num   = s => { const m=String(s).replace(/,/g,"").match(/-?\d+(\.\d+)?/); return m?+m[0]:null; };

/** UTC hour → trading session (spec §7.2). Honest "unknown" when no time is recorded. */
function sessionOf(iso){
  if(!iso || !/T\d\d:/.test(iso)) return "unknown";
  const h = new Date(iso).getUTCHours();
  if(h < 7)  return "asia";
  if(h < 12) return "london";
  if(h < 16) return "london-ny-overlap";
  if(h < 21) return "new-york";
  return "dead";
}

/** Minimal YAML frontmatter reader — handles scalars, quoted strings and [a, b] arrays. */
function frontmatter(text){
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if(!m) return {};
  const fm = {};
  let key = null;
  for(const raw of m[1].split(/\r?\n/)){
    const kv = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(raw);
    if(kv){
      key = kv[1];
      let v = kv[2].trim();
      if(v.startsWith("[") && v.endsWith("]"))
        fm[key] = v.slice(1,-1).split(",").map(s=>s.trim().replace(/^["']|["']$/g,"")).filter(Boolean);
      else if(v) fm[key] = v.replace(/^["']|["']$/g,"");
      else fm[key] = "";
    } else if(key && /^\s+\S/.test(raw)){
      fm[key] = (fm[key] ? fm[key]+" " : "") + raw.trim().replace(/^["']|["']$/g,"");
    }
  }
  return fm;
}

/* Which analytical lens does a piece of evidence belong to?
   These map 1:1 onto the watcher families, so the benchmark can ask
   "which watcher would have been responsible for seeing this?" */
const LENS = [
  ["structure",  /\bBOS\b|CHoCH|order block|\bOB\b|FVG|fair value gap|sweep|liquidity grab|swing (high|low)|higher[- ]low|lower[- ]high|golden pocket|fib|retrace/i],
  ["level",      /support|resistance|shelf|pivot|round number|\bR[1-4]\b|\bS[1-4]\b|must[- ]hold|cap\b/i],
  ["flow",       /volume|open interest|\bOI\b|funding|taker|L\/S|long\/short|crowd/i],
  ["sentiment",  /fear.?&.?greed|sentiment|stoch|RSI|overbought|oversold|CCI/i],
  ["regime",     /\bADX\b|\bATR\b|bollinger|regime|trend(less)?|ranging|chop/i],
  ["correlation",/DXY|USDT\.D|dominance|yield|real[- ]yield|correlat|divergen|gold|SPX|NASDAQ/i],
  ["macro",      /FOMC|CPI|NFP|ECB|BoE|BoJ|rate|central bank|calendar|print\b/i],
  ["campaign",   /campaign|continuation|stop ladder|runner|trail/i]
];
function lensesIn(text){
  const out = [];
  for(const [name, re] of LENS) if(re.test(text)) out.push(name);
  return out;
}

/* Pull the evidence bullets out of a note. Format drifted across 32 notes,
   so we take: hypothesis evidence blocks, "Key levels" rows, and macro chips. */
function evidenceFrom(text){
  const ev = [];
  // bolded lead-ins in the hypotheses / MTF / red-team prose
  const bullets = text.match(/^[-*>|]\s*.*$/gm) || [];
  for(const b of bullets.slice(0, 400)){
    const c = clean(b).replace(/^[-*>|]\s*/,"");
    if(c.length < 12 || c.length > 260) continue;
    if(/^\|?\s*(Level|Date|TF|07-|06-)/.test(c)) continue;
    const ls = lensesIn(c);
    if(!ls.length) continue;
    ev.push({ lens: ls[0], lenses: ls, claim: c.slice(0,240) });
  }
  return ev.slice(0, 40);
}

/* Timeframes the conclusion actually rested on. */
function timeframesIn(text){
  const tf = new Set();
  for(const m of text.matchAll(/\b(1W|1D|4H|1H|30m|15m|5m|weekly|daily)\b/gi)){
    const v = m[1].toLowerCase();
    tf.add(v==="weekly"?"1W":v==="daily"?"1D":m[1].toUpperCase().replace("M","m"));
  }
  return [...tf];
}

/* ---------- 1 · conclusions from the analyses ---------------- */
function extractConclusions(){
  const out = [];
  for(const f of fs.readdirSync(ANALYSES).filter(x=>x.endsWith(".md")).sort()){
    const text = fs.readFileSync(path.join(ANALYSES, f), "utf8");
    const fm   = frontmatter(text);
    const date = (fm.created || (f.match(/^(\d{4}-\d{2}-\d{2})/)||[])[1] || "").slice(0,10);
    if(!date) continue;

    /* a multi-asset note (the FX reads cover 3 pairs) becomes one record PER asset,
       otherwise GBPUSD/USDJPY conclusions vanish from the benchmark */
    let assets = [];
    if(Array.isArray(fm.assets) && fm.assets.length) assets = fm.assets.filter(a=>!/^DXY$/i.test(a));
    else if(fm.asset) assets = [fm.asset];
    else if(/XAU|GOLD/i.test(f)) assets = ["XAUUSD"];
    else if(/EURUSD/i.test(f))   assets = ["EURUSD"];
    else if(/\bFX\b/i.test(f))   assets = ["EURUSD","GBPUSD","USDJPY"];
    else assets = ["BTCUSDT"];                      // vault was BTC-only pre-07-17
    const asOf = fm.as_of_time ? `${date}T${fm.as_of_time.replace(/[^\d:]/g,"")}Z` : date;
    for(const asset of assets){

    const pBull = num(fm.prob_bull) ?? num(fm.prob_long) ?? num(fm.prob_up);
    const pBear = num(fm.prob_bear) ?? num(fm.prob_short) ?? num(fm.prob_down);

    out.push({
      id: `gt_${date}_${asset}_${out.length}`,
      date, asOf, asset, note: f,
      /* ---- CONTEXT: why this conclusion was reachable ---- */
      context: {
        regime:     fm.regime || null,
        session:    sessionOf(asOf),
        livePrice:  num(fm.live_price) ?? num(fm.as_of_price) ?? num(fm.price_at_analysis),
        timeframes: timeframesIn(text),
        tags:       Array.isArray(fm.tags) ? fm.tags : (fm.tags?String(fm.tags).split(/[,\s]+/):[]),
        formatV2:   /official-format-v2/.test(String(fm.tags)),
        consolidated:/consolidated|external-read/.test(String(fm.tags))
      },
      /* ---- REASONING: the evidence and the competing explanations ---- */
      reasoning: {
        lenses:   lensesIn(text),
        evidence: evidenceFrom(text),
        hypotheses: [...text.matchAll(/\*\*H(\d)\s*·\s*(.+?)\s*[—-]\s*P\s*([0-9.]+)\.?\*\*/g)]
                      .map(m=>({ n:+m[1], name:clean(m[2]), p:+m[3] })),
        invalidator: (text.match(/[Ii]nvalidat(?:ion|or)[:\s—-]+([^\n.]{6,180})/)||[])[1] || null,
        redTeam: /[Rr]ed team/.test(text)
      },
      /* ---- CONCLUSION ---- */
      conclusion: {
        probBull: pBull, probBear: pBear,
        bias: (pBull!=null&&pBear!=null) ? (pBull>pBear?"bull":pBull<pBear?"bear":"neutral") : null,
        confidence: (pBull!=null&&pBear!=null) ? Math.max(pBull,pBear)/100 : null,
        primarySetup: fm.primary_setup || null,
        verdict: fm.verdict ? String(fm.verdict).slice(0,400) : null
      },
      outcome: null,           // joined from the scorecard below
      multiAsset: assets.length > 1
    });
    }
  }
  return out;
}

/* ---------- 2 · outcomes from the Setup Scorecard ------------ */
function extractOutcomes(){
  const text = fs.readFileSync(SCORECARD, "utf8");
  const out = [];
  for(const line of text.split(/\r?\n/)){
    if(!line.trim().startsWith("|") || line.count === 0) continue;
    if(/^\|[\s\-:|]+\|$/.test(line.trim())) continue;
    const c = line.trim().replace(/^\|/,"").replace(/\|$/,"").split("|").map(s=>s.trim());
    if(c.length < 9) continue;
    if(/^Date$/i.test(clean(c[0])) || /Trigger \/ entry/i.test(c[2])) continue;
    const label = clean(c[0]);
    if(!/^\d{2}-\d{2}/.test(label)) continue;

    const dir = clean(c[1]).split(/\s+/)[0];
    if(!/^(LONG|SHORT)/i.test(dir)) continue;

    let asset = /BTC/i.test(label) ? "BTCUSDT"
              : /XAU/i.test(label) ? "XAUUSD"
              : /EURUSD/i.test(label) ? "EURUSD"
              : /GBPUSD/i.test(label) ? "GBPUSD"
              : /USDJPY/i.test(label) ? "USDJPY"
              : "BTCUSDT";                                  // pre-07-17 rows are BTC
    const firedRaw  = clean(c[5]).toLowerCase();
    const resultRaw = clean(c[6]);
    const fired = /yes|filled|fired|both condition|precondition|est\./.test(firedRaw) ? true
                : /^no|neither|by\s+\d+\s*point/.test(firedRaw) ? false : null;
    const r = num(c[7]);
    let cls = "open";
    if(/no-trigger|neither/i.test(resultRaw)) cls = "no-trigger";
    else if(/stopped|wrong-side|failed/i.test(resultRaw)) cls = "loss";
    else if(/win|T1|T2|T3|\+/i.test(resultRaw) && (r==null || r>0)) cls = "win";
    else if(/armed|watch|carried/i.test(resultRaw)) cls = "open";

    out.push({
      label, asset, dir: dir.toUpperCase(),
      zone: clean(c[2]), stop: clean(c[3]), targets: clean(c[4]),
      fired, result: resultRaw, class: cls, r,
      notes: clean(c[8]).slice(0,400),
      /* the recurring failure modes, machine-taggable */
      leak: /entry too high|too high|missed by|by \d+ ?(pts|points|pips)/i.test(c[8]) ? "entry-placement"
          : /swept|stop at the obvious|obvious level/i.test(c[8]) ? "stop-placement"
          : /wrong-side|wrong direction/i.test(c[8]) ? "wrong-side-into-event"
          : /never rested|far-fade/i.test(c[8]) ? "far-fade"
          : null,
      date: "2026-" + label.slice(0,5)
    });
  }
  return out;
}

/* ---------- 3 · join + emit --------------------------------- */
function build(){
  const conclusions = extractConclusions();
  const outcomes    = extractOutcomes();

  // attach outcomes to the conclusion of the same asset+date
  for(const c of conclusions){
    const mine = outcomes.filter(o => o.asset === c.asset && o.date === c.date);
    if(mine.length) c.outcome = { setups: mine, n: mine.length };
  }

  let labelledEvents = [];
  try { labelledEvents = require("./labelled-events.js").EVENTS; } catch(e){}

  const byAsset = {};
  for(const c of conclusions) byAsset[c.asset] = (byAsset[c.asset]||0)+1;
  const scored = outcomes.filter(o => o.class==="win"||o.class==="loss"||o.class==="no-trigger");

  const ds = {
    benchmark: "dimitry-calibration",
    version: "1.0.0",
    frozenAt: new Date().toISOString(),
    purpose: "Permanent benchmark. Every watcher and every future parameter change is scored against this BEFORE deployment. Built from the operator's own historical analyses — never from watcher output.",
    coverage: {
      notes: conclusions.length,
      dateRange: [conclusions[0] && conclusions[0].date, conclusions[conclusions.length-1] && conclusions[conclusions.length-1].date],
      byAsset,
      withProbabilities: conclusions.filter(c=>c.conclusion.probBull!=null).length,
      withRegime:        conclusions.filter(c=>c.context.regime).length,
      withHypotheses:    conclusions.filter(c=>c.reasoning.hypotheses.length).length,
      outcomes: outcomes.length,
      outcomesScored: scored.length,
      labelledEvents: labelledEvents.length
    },
    /* honest limits — a benchmark that hides its gaps is worse than none */
    limits: [
      "Frontmatter schema drifted: only 17/32 notes carry prob_bull/prob_bear, so bias-calibration (Brier) is scoreable on those 17 only.",
      "Session is 'unknown' where no as_of_time was recorded — do not infer session-conditional skill from those rows.",
      "Asset coverage is heavily BTC-weighted. XAU and FX have too few rows for independent gates; calibrate BTC first.",
      "Evidence bullets are regex-classified by lens and are indicative, not exhaustive.",
      "labelled-events.js is hand-curated: it is the authoritative scoring target for watchers, and is deliberately small and verified rather than large and noisy."
    ],
    conclusions, outcomes, labelledEvents
  };

  fs.writeFileSync(OUT, JSON.stringify(ds, null, 1));
  return ds;
}

if(require.main === module){
  const ds = build();
  console.log(`calibration benchmark → ${OUT}\n`);
  console.log("coverage:", JSON.stringify(ds.coverage, null, 1));
  console.log("\nlens frequency across all notes:");
  const lf = {};
  ds.conclusions.forEach(c=>c.reasoning.lenses.forEach(l=>lf[l]=(lf[l]||0)+1));
  Object.entries(lf).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log(`  ${String(v).padStart(3)}  ${k}`));
  console.log("\noutcome classes:");
  const oc = {};
  ds.outcomes.forEach(o=>oc[o.class]=(oc[o.class]||0)+1);
  Object.entries(oc).forEach(([k,v])=>console.log(`  ${String(v).padStart(3)}  ${k}`));
  console.log("\nmeasured leaks (the failure modes the watchers must respect):");
  const lk = {};
  ds.outcomes.forEach(o=>{ if(o.leak) lk[o.leak]=(lk[o.leak]||0)+1; });
  Object.entries(lk).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log(`  ${String(v).padStart(3)}  ${k}`));
}
module.exports = { build, sessionOf, frontmatter, lensesIn };
