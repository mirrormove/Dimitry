/* ============================================================================
   analysis-source.js — THE single source of truth for setups, served to BOTH
   the web dashboard and the mobile Commander.

   The web dashboard authors the rich analysis inline as a `VAULT` object
   (thesis, levels+touch-odds, setups with zones/targets/windows/tiers). Rather
   than duplicate that (which is how web & mobile drifted — BTC showed two
   different entries), this module EXTRACTS that exact object at request time
   and serves it. Web renders the literal; mobile renders the served copy of the
   same literal → they can never disagree.

   Pure-data extraction: the VAULT region is object literals + Array.find(), no
   DOM, so it evaluates safely in a bare vm sandbox. Cached by file mtime.
   ============================================================================ */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const DASH = path.resolve(__dirname, "..", "Dimitry Dashboard.html");

let _cache = null, _mtime = 0;

/* Slice the `const VAULT = { ... }` region (through its trailing
   `VAULT.assets[n].analysis = {...}` assignments) out of the dashboard HTML and
   evaluate it. Returns the fully-populated VAULT object. */
function extract(html){
  const start = html.indexOf("const VAULT = {");
  if(start < 0) throw new Error("VAULT literal not found in dashboard");
  // the region ends at the render code that begins `const $ = id => document...`
  const endMark = html.indexOf("const $ = id => document.getElementById", start);
  if(endMark < 0) throw new Error("VAULT region terminator not found");
  const code = html.slice(start, endMark);
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(code + "\n;globalThis.__VAULT = VAULT;", sandbox, { timeout: 3000 });
  const V = sandbox.__VAULT;
  if(!V || !Array.isArray(V.assets)) throw new Error("VAULT extracted but malformed");
  return V;
}

/* Cached accessor — re-extracts only when the dashboard file changes. */
function getVault(){
  const st = fs.statSync(DASH);
  if(_cache && st.mtimeMs === _mtime) return _cache;
  const html = fs.readFileSync(DASH, "utf8");
  _cache = extract(html);
  _mtime = st.mtimeMs;
  return _cache;
}

module.exports = { getVault, DASH };
