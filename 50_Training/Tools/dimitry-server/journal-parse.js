/* ============================================================================
   journal-parse.js — turn a free-text journal entry into STRUCTURED, LINKED data.

   The operator should be able to just type. This module extracts the facts a
   trading brain can actually use — asset, direction, prices, R, size, outcome,
   the setup it refers to, and the DISCIPLINE tags (chased / fomo / cut early /
   moved stop / followed plan) that feed the leak model.

   Pure functions, zero deps. Never throws on bad input — returns what it found.
   ============================================================================ */

/* --- asset recognition: symbol, alias, and colloquial name --------------- */
const ASSETS = [
  { id:"BTC",    re:/\b(btc|bitcoin|btcusdt?|btcusd|xbt)\b/i },
  { id:"XAUUSD", re:/\b(xauusd|gold|xau)\b/i },
  { id:"XAGUSD", re:/\b(xagusd|silver|xag)\b/i },
  { id:"US500",  re:/\b(us500|s&?p ?500|spx|sp500|es)\b/i },
  { id:"US100",  re:/\b(us100|nas(daq)?( ?100)?|ndx|nq)\b/i },
  { id:"EURUSD", re:/\b(eurusd|euro?|fiber)\b/i },
  { id:"GBPUSD", re:/\b(gbpusd|cable|sterling|pound)\b/i },
  { id:"USDJPY", re:/\b(usdjpy|yen|ninja)\b/i },
  { id:"DXY",    re:/\b(dxy|dollar index)\b/i },
];

/* --- discipline / process tags: the leak model's raw input --------------- */
const TAGS = [
  { tag:"followed-plan",  good:true,  re:/\b(followed (the )?plan|by the book|as written|per the plan|stuck to)\b/i },
  { tag:"patient",        good:true,  re:/\b(waited|patience|let it come|no chase)\b/i },
  { tag:"chased",         good:false, re:/\b(chased?|chasing|fomo|jumped in|couldn'?t wait)\b/i },
  { tag:"revenge",        good:false, re:/\b(revenge|tilt|angry|get it back|made it back)\b/i },
  { tag:"moved-stop",     good:false, re:/\b(moved (my |the )?stop|widened (the )?stop|removed (the )?stop|no stop)\b/i },
  { tag:"cut-early",      good:false, re:/\b(cut (it )?early|closed early|took (it )?off early|bailed|scratched)\b/i },
  { tag:"held-too-long",  good:false, re:/\b(held too long|round.?tripped|gave it back|let it run too far)\b/i },
  { tag:"oversized",      good:false, re:/\b(over ?sized?|too big|full send|max size)\b/i },
  { tag:"stop-to-be",     good:true,  re:/\b(stop to (be|break.?even)|moved to be|risk.?free)\b/i },
  { tag:"skipped",        good:null,  re:/\b(skipped?|passed on|didn'?t take|no trade)\b/i },
  { tag:"news-window",    good:false, re:/\b(nfp|cpi|fomc|pce|news|print)\b/i },
];

const OUTCOMES = [
  { outcome:"win",      re:/\b(won|win|banked|profit|target|tp hit|t[12] hit|green|\+\d)\b/i },
  { outcome:"loss",     re:/\b(lost|loss|stopped out|stop hit|sl hit|red|-\d)\b/i },
  { outcome:"breakeven",re:/\b(break.?even|be|scratch|flat)\b/i },
];

const num = s => { const n = parseFloat(String(s).replace(/[,$\s]/g,"")); return isFinite(n)?n:null; };
const N = "(\\d[\\d,]*(?:\\.\\d+)?)";

/** Extract every fact we can from a free-text entry.
 *  @param {string} text  what the operator typed
 *  @param {string} kind  note | execution | exit | observation | trade
 *  @param {object} ctx   {assets:[ids]} optional, to widen recognition
 *  @returns {object} structured record (fields are null when not found) */
function parseEntry(text, kind, ctx){
  const t = String(text||"");
  const low = t.toLowerCase();
  const out = {
    kind: kind || "note",
    asset:null, dir:null, entry:null, exit:null, stop:null, targets:[],
    size:null, sizeUnit:null, r:null, pnl:null, pnlCcy:null,
    outcome:null, setupRef:null, tags:[], levels:[], numbers:[],
    hasQuestion:/\?/.test(t), words: t.trim()? t.trim().split(/\s+/).length : 0
  };
  if(!t.trim()) return out;

  /* asset */
  for(const a of ASSETS){ if(a.re.test(t)){ out.asset = a.id; break; } }

  /* direction — include past-tense verb forms ("longed", "shorted") */
  const isLong  = /\b(long|longs|longed|longing|bought|buy|buying|bid)\b/i.test(t);
  const isShort = /\b(short|shorts|shorted|shorting|sold|sell|selling|fade|faded|fading)\b/i.test(t);
  out.dir = isLong && !isShort ? "long" : isShort && !isLong ? "short"
          : isLong ? "long" : isShort ? "short" : null;

  /* explicit labelled prices.
     GAP allows the asset/filler between the verb and the number — real people
     write "longed BTC at 62871" and "closed the BTC long at 63325", not "entry:62871". */
  const GAP = "(?:[^\\n]{0,18}?)";   /* lazy: must tolerate digit-bearing symbols (US500, US100) */
  const grab = re => { const m = re.exec(t); return m ? num(m[1]) : null; };
  /* (?<![A-Za-z#]) — never read a number that is glued to letters, so the "100"
     inside "US100" or the "1" in "T1" can't be mistaken for a price. */
  const at = (verbs, guard) => {
    const re = new RegExp("\\b(?:"+verbs+")\\b"+GAP+"(?:at|@|:|for|around|near)?\\s*\\$?\\s*(?<![A-Za-z#\\d.,])"+N, "i");
    const m = re.exec(t);
    if(!m) return null;
    /* don't let "stop"/"target" words inside the gap steal the number */
    if(guard!==false && /\b(stop|sl|target|tp|t\d)\b/i.test(m[0].slice(0, m[0].lastIndexOf(m[1])))) return null;
    return num(m[1]);
  };
  out.entry = at("entry|entered|enter|filled|fill|opened|open|bought|buy|longed|shorted|took|in at")
           ?? grab(new RegExp("@\\s*\\$?\\s*"+N, "i"))
           ?? grab(new RegExp("\\bfrom\\s*\\$?\\s*"+N, "i"));
  out.exit  = at("exit|exited|closed|close|out at|sold at|took profit|tp hit|banked at");
  out.stop  = grab(new RegExp("(?:stop|sl|stop.?loss)(?:\\s*(?:was|is|at|@|:|to))?\\s*\\$?\\s*"+N, "i"));
  /* "closed X at A from B" → A is the exit, B is the entry */
  if(out.exit!=null){
    const fr = grab(new RegExp("\\bfrom\\s*\\$?\\s*"+N, "i"));
    if(fr!=null && fr!==out.exit) out.entry = fr;
  }

  /* targets: T1/T2/T3 or "target 63,325" */
  for(const m of t.matchAll(new RegExp("\\bt(\\d)\\s*(?:at|@|:)?\\s*\\$?\\s*"+N, "gi")))
    out.targets.push({ n:+m[1], p:num(m[2]) });
  if(!out.targets.length){
    const tg = grab(new RegExp("(?:target|tp)\\s*(?:at|@|:)?\\s*\\$?\\s*"+N, "i"));
    if(tg!=null) out.targets.push({ n:1, p:tg });
  }

  /* R multiple — "+2R", "-1.5R", "2R" */
  const rm = /([+-]?\d+(?:\.\d+)?)\s*R\b/i.exec(t);
  if(rm) out.r = parseFloat(rm[1]);

  /* money P&L — "+$120", "-12.40 usd" */
  const pm = /([+-]?)\s*\$\s*(\d[\d,]*(?:\.\d+)?)|([+-]\d[\d,]*(?:\.\d+)?)\s*(usd|usdt|\$)/i.exec(t);
  if(pm){ const sign = (pm[1]==="-"||/^-/.test(pm[3]||"")) ? -1 : 1;
    const v = num(pm[2]!=null?pm[2]:pm[3]); if(v!=null){ out.pnl = sign*Math.abs(v); out.pnlCcy="USD"; } }

  /* size — "0.05 lots", "0.75%", "risked 1%" */
  const sl = new RegExp("("+N.slice(1,-1)+")\\s*(lots?|contracts?)","i").exec(t);
  const sp = /(\d+(?:\.\d+)?)\s*%/.exec(t);
  if(sl){ out.size = num(sl[1]); out.sizeUnit="lots"; }
  else if(sp){ out.size = parseFloat(sp[1]); out.sizeUnit="%"; }

  /* outcome */
  for(const o of OUTCOMES){ if(o.re.test(t)){ out.outcome = o.outcome; break; } }
  if(out.r!=null) out.outcome = out.r>0.05 ? "win" : out.r<-0.05 ? "loss" : "breakeven";

  /* discipline tags */
  for(const g of TAGS){ if(g.re.test(t)) out.tags.push({ tag:g.tag, good:g.good }); }

  /* explicit setup reference — "BTC#0" or "the primary" */
  const sr = /\b([A-Z]{2,7})\s*#\s*(\d+)\b/.exec(t);
  if(sr) out.setupRef = sr[1].toUpperCase()+"#"+sr[2];
  else if(/\bprimary\b/i.test(t) && out.asset) out.setupRef = out.asset+"#0";

  /* every standalone number, for level references */
  for(const m of t.matchAll(/\$?\s*(\d[\d,]{2,}(?:\.\d+)?)/g)){
    const v = num(m[1]); if(v!=null && v>=1) out.numbers.push(v);
  }
  out.levels = [...new Set(out.numbers)].filter(v =>
    v!==out.entry && v!==out.exit && v!==out.stop && !out.targets.some(x=>x.p===v));

  /* derive R when we have entry/exit/stop but no explicit R */
  if(out.r==null && out.entry!=null && out.exit!=null && out.stop!=null){
    const risk = Math.abs(out.entry-out.stop);
    if(risk>0){ const move = (out.dir==="short") ? (out.entry-out.exit) : (out.exit-out.entry);
      out.r = +(move/risk).toFixed(2);
      out.outcome = out.r>0.05?"win":out.r<-0.05?"loss":"breakeven"; }
  }

  /* infer a better kind when the operator didn't pick one */
  if(!kind || kind==="trade" || kind==="note"){
    if(out.exit!=null || out.r!=null || out.outcome) out.kind="exit";
    else if(out.entry!=null || /\b(entered|opened|filled|took the)\b/i.test(t)) out.kind="execution";
    else if(out.asset || out.setupRef) out.kind="observation";
    else out.kind="note";
  }
  return out;
}

/** One-line human summary of a parsed entry — what the app shows in the list. */
function summarise(pd){
  if(!pd) return "";
  const bits=[];
  if(pd.asset) bits.push(pd.asset);
  if(pd.dir) bits.push(pd.dir.toUpperCase());
  if(pd.entry!=null) bits.push("@"+pd.entry.toLocaleString());
  if(pd.exit!=null) bits.push("→"+pd.exit.toLocaleString());
  if(pd.r!=null) bits.push((pd.r>0?"+":"")+pd.r+"R");
  else if(pd.pnl!=null) bits.push((pd.pnl>0?"+":"")+"$"+Math.abs(pd.pnl));
  if(!bits.length) return ({note:"note",observation:"market note"}[pd.kind])||"entry";
  return bits.join(" ");
}

/** Roll a set of parsed entries into review stats. */
function digest(entries){
  const withR = entries.filter(e=>e.parsed && e.parsed.r!=null);
  const wins = withR.filter(e=>e.parsed.r>0.05).length;
  const losses = withR.filter(e=>e.parsed.r<-0.05).length;
  const totalR = +withR.reduce((s,e)=>s+e.parsed.r,0).toFixed(2);
  const tally = {};
  entries.forEach(e=>(e.parsed&&e.parsed.tags||[]).forEach(t=>{
    tally[t.tag] = tally[t.tag]||{n:0,good:t.good}; tally[t.tag].n++; }));
  const leaks = Object.entries(tally).filter(([,v])=>v.good===false)
    .sort((a,b)=>b[1].n-a[1].n).map(([tag,v])=>({tag,n:v.n}));
  const strengths = Object.entries(tally).filter(([,v])=>v.good===true)
    .sort((a,b)=>b[1].n-a[1].n).map(([tag,v])=>({tag,n:v.n}));
  return { n:entries.length, scored:withR.length, wins, losses, totalR,
           winRate: withR.length ? Math.round(wins/withR.length*100) : null, leaks, strengths };
}

module.exports = { parseEntry, summarise, digest, ASSETS, TAGS };
