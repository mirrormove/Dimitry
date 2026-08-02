/* ============================================================
   INVALIDATOR PARSER          Vault Intelligence v4 · Step 3
   Zero dependencies.

   Turns the invalidator strings the AGENT ALREADY WROTE on each belief
   into machine-checkable predicates.

   This is why the T1 rule engine is legitimate under the v3 structural
   rule ("never simulate reasoning in JS"): it does not invent a rule and
   it does not decide what a broken level means. It only checks a
   condition the operator or the agent has already committed to in
   writing, which today waits on a human to notice. That is bookkeeping.

   Anything it cannot parse is returned as {parsed:false, reason} and
   surfaced — NEVER silently ignored. A rule engine that quietly skips
   what it does not understand is worse than none, because you would
   believe an invalidation was being watched when it was not.
   ============================================================ */
"use strict";

const TF_ALIAS = {
  "1w":"1W", "weekly":"1W", "week":"1W",
  "1d":"1D", "daily":"1D", "day":"1D",
  "4h":"4H", "1h":"1H", "30m":"30m", "15m":"15m", "5m":"5m"
};
const num = s => parseFloat(String(s).replace(/,/g, ""));

/**
 * Parse one clause, e.g.
 *   "1D close > 67,292"
 *   "GBPUSD 4H close > 1.33934"
 *   "4H close > 66,400 on volume > 1.5x avg"
 *   "hold/reclaim above 163.823"
 */
function parseClause(raw, defaultAsset){
  const s = String(raw).trim();

  /* optional leading asset, e.g. "EURUSD daily close > 1.1418" */
  let asset = defaultAsset || null;
  const am = /^([A-Z]{3,10}(?:USDT?)?)\s+/.exec(s);
  let body = s;
  if(am && /^(BTC|ETH|XAU|XAG|EUR|GBP|USD|AUD|NZD|CAD|CHF|JPY|SOL|DXY)/.test(am[1])){
    asset = am[1]; body = s.slice(am[0].length);
  }

  /* form A — "<tf> close <cmp> <price>"  (the dominant form) */
  let m = /(1W|1D|4H|1H|30m|15m|5m|weekly|daily|week|day)\s*(?:candle\s*)?clos(?:e|ed|ing)\s*(?:back\s*)?(>|<|above|below|over|under)\s*\$?\s*([\d,]+\.?\d*)/i.exec(body);
  if(m){
    const tf  = TF_ALIAS[m[1].toLowerCase()] || m[1].toUpperCase();
    const dir = /^(>|above|over)$/i.test(m[2]) ? "above" : "below";
    const out = { parsed:true, kind:"close", asset, tf, dir, level:num(m[3]), hold:1, raw:s };
    /* optional volume qualifier — "on volume > 1.5x avg" */
    const v = /volume\s*(?:>|above)\s*([\d.]+)\s*[x×]/i.exec(body);
    if(v) out.volMult = parseFloat(v[1]);
    return out;
  }

  /* form B — "hold/reclaim above X" : needs price to SUSTAIN above the level,
     not merely tag it, so it requires two consecutive closes.               */
  m = /(?:hold|reclaim|holds|reclaims)[^\d<>]*?(>|above|over)?\s*\$?\s*([\d,]+\.?\d*)/i.exec(body);
  if(m && /hold|reclaim/i.test(body)){
    return { parsed:true, kind:"close", asset, tf:"4H", dir:"above",
             level:num(m[2]), hold:2, raw:s,
             note:"'hold/reclaim' requires two consecutive closes beyond the level, not a tag" };
  }

  /* form C — bare "<cmp> <price>" with a timeframe mentioned anywhere */
  m = /(>|<|above|below)\s*\$?\s*([\d,]+\.?\d*)/.exec(body);
  if(m){
    const tfm = /(1W|1D|4H|1H|weekly|daily)/i.exec(body);
    if(tfm){
      return { parsed:true, kind:"close", asset,
               tf: TF_ALIAS[tfm[1].toLowerCase()] || tfm[1].toUpperCase(),
               dir: /^(>|above)$/i.test(m[1]) ? "above" : "below",
               level:num(m[2]), hold:1, raw:s };
    }
  }

  return { parsed:false, raw:s, reason:"no timeframe + close + price pattern found — needs a human or the agent" };
}

/**
 * Parse a full invalidator, which may be several clauses joined by AND / OR.
 * @returns {{parsed:boolean, join:"AND"|"OR"|null, clauses:Array, raw:string}}
 */
function parse(raw, defaultAsset){
  if(!raw || typeof raw !== "string") return { parsed:false, clauses:[], raw:String(raw||""), reason:"empty" };

  /* strip trailing prose after the condition — "(bullish CHoCH, first HH since June)" */
  const cleaned = raw.replace(/\s*\((?![^)]*[<>])[^)]*\)\s*/g, " ").trim();

  const join = /\bAND\b/i.test(cleaned) ? "AND" : /\bOR\b/i.test(cleaned) ? "OR" : null;
  const parts = join ? cleaned.split(/\s+(?:AND|OR)\s+/i) : [cleaned];
  const clauses = parts.map(p => parseClause(p, defaultAsset));

  return {
    parsed: clauses.every(c => c.parsed),
    join, clauses, raw,
    unparsed: clauses.filter(c => !c.parsed).map(c => c.raw)
  };
}

/**
 * Has a clause fired against real candles?
 * @param clause  from parseClause
 * @param candles ascending [{t,o,h,l,c,v}] for that clause's timeframe
 * @param since   only consider bars at/after this time (the belief's setAt)
 */
function clauseFired(clause, candles, since){
  if(!clause.parsed || !candles || !candles.length) return { fired:false, reason:"no data" };
  const bars = candles.filter(c => c.t >= (since || 0));
  if(!bars.length) return { fired:false, reason:"no bars since the belief was set" };

  const beyond = c => clause.dir === "above" ? c.c > clause.level : c.c < clause.level;
  let streak = 0;
  for(const b of bars){
    if(beyond(b)){
      streak++;
      if(streak >= (clause.hold || 1)){
        /* volume qualifier, when the belief demanded one */
        if(clause.volMult){
          const i = bars.indexOf(b);
          const prior = bars.slice(Math.max(0, i-20), i).map(x=>x.v||0).filter(Boolean);
          const avg = prior.length ? prior.reduce((a,c2)=>a+c2,0)/prior.length : null;
          const mult = avg ? (b.v||0)/avg : null;
          if(mult == null || mult < clause.volMult)
            return { fired:false, reason:`price condition met but volume ${mult==null?"unknown":mult.toFixed(2)+"x"} < ${clause.volMult}x — the gate the belief demanded`,
                     partial:true, at:b.t, close:b.c };
        }
        return { fired:true, at:b.t, close:b.c, level:clause.level, dir:clause.dir,
                 holdMet:clause.hold||1 };
      }
    } else streak = 0;
  }
  return { fired:false, reason:"condition not met in the available bars" };
}

/** Evaluate a whole parsed invalidator against a {tf: candles} map. */
function evaluate(parsedInv, candlesByTf, since){
  if(!parsedInv.parsed) return { fired:false, unparsed:true, reason:"invalidator not machine-checkable", detail:parsedInv.unparsed };
  const results = parsedInv.clauses.map(c => ({ clause:c, res: clauseFired(c, candlesByTf[c.tf], since) }));
  const fired = parsedInv.join === "AND" ? results.every(r => r.res.fired)
                                         : results.some(r => r.res.fired);
  return { fired, join:parsedInv.join, results,
           firedClauses: results.filter(r=>r.res.fired).map(r=>({ raw:r.clause.raw, at:r.res.at, close:r.res.close })) };
}

module.exports = { parse, parseClause, clauseFired, evaluate, TF_ALIAS };
