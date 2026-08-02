---
title: "Dimitry — UI/UX Design System (portable spec)"
type: spec
domain: 50_Training/Tools
created: 2026-08-01
updated: 2026-08-01
status: living
tags: [ui, ux, design-system, spec, portable, mobile, dashboard]
---

# Dimitry — UI/UX Design System

> **Purpose.** A self-contained spec for rebuilding this interface in another project. It documents the *rules*, the *tokens*, the *components* and the *interaction patterns* — not this vault's trading content. Everything here is vanilla HTML/CSS/JS with **zero dependencies, zero build step, single-file deliverables**.

---

## 1. First principles (the non-negotiables)

These are what make the interface feel like itself. Port these before any pixel.

1. **Colour means a decision — nothing else.** Green = act long. Red = act short. Amber = wait. Blue = information/system. Grey = asleep/closed. Never use colour decoratively, never for branding flourish. If an element isn't telling the user what to *do*, it is greyscale. This is the single highest-leverage rule.
2. **One glance, one answer.** The top of the primary screen answers the user's actual question in under 3 seconds. Everything else is progressive disclosure beneath it.
3. **Two surfaces, one source.** The desktop surface is the *reasoning* view ("why"); the mobile surface is the *decision* view ("what do I do"). **Mobile is a streamlined form of desktop, never a different truth.** Both render the same served object — see §8.
4. **Dark, dense, calm.** Near-black canvas, low-chroma panels, hairline borders. Motion is slow and ambient (2.4–5.5s cycles), never bouncy. Nothing flashes for attention except state that genuinely changed.
5. **Numbers are monospace and tabular.** Any figure a user compares or reads precisely uses the mono stack + `font-variant-numeric: tabular-nums` so digits don't jitter between refreshes.
6. **Honest empty states.** When there's nothing to show, say so plainly and say what it means ("no armed setup — protect capital"), never a spinner that implies something is coming.
7. **State is earned, not assumed.** Any live indicator must be driven by real data; if data is missing show "—" rather than a plausible default.

---

## 2. Design tokens

### 2.1 Mobile (Commander) — near-black, higher contrast
```css
:root{
  --bg:#070a0d;      /* canvas */
  --card:#0c1218;    /* raised surface */
  --card2:#0a1015;   /* inset surface (inputs, wells) */
  --line:#16212b;    /* hairline border */
  --ink:#eef4f8;     /* primary text */
  --mut:#93a3ad;     /* secondary text */
  --dim:#5a6b76;     /* tertiary / labels */

  /* decision colours — the only chroma in the system */
  --long:#2fbf7a; --short:#e5484d; --wait:#d99b28; --info:#3f7fd6; --sleep:#4a5a64;

  --mono:ui-monospace,SFMono-Regular,Menlo,monospace;
  --acc:var(--sleep);   /* per-view accent, set in JS to the decision colour */
}
```

### 2.2 Desktop (Dashboard) — slightly lifted, denser data
```css
:root{
  --bg:#0b0f17; --panel:#121826; --panel2:#0e1420; --line:#1f2937;
  --text:#e5e9f0; --muted:#8b95a7; --dim:#5c6675;
  --green:#22c55e; --red:#ef4444; --amber:#f0b429; --blue:#60a5fa;
  --green-bg:rgba(34,197,94,.10); --red-bg:rgba(239,68,68,.10); --amber-bg:rgba(240,180,41,.10);
  --mono:'Consolas','SF Mono','Menlo',monospace;
}
```

> **Mapping between surfaces:** `--long↔--green`, `--short↔--red`, `--wait↔--amber`, `--info↔--blue`. Keep the *semantics* identical even though the hexes differ slightly per surface (mobile is tuned for OLED, desktop for long reading sessions).

### 2.3 The accent pattern (`--acc`) — port this
A single CSS variable carries "what is the current decision", set once in JS and inherited by every child. It lets one component render in any decision colour with no conditional CSS.

```js
const accOf = d => d==="short" ? "var(--short)"
                 : d==="long"  ? "var(--long)"
                 : "var(--wait)";
document.documentElement.style.setProperty("--acc", accOf(dir));   // global
// or scoped to one card:  <div style="--acc:${accOf(dir)}">…</div>
```

### 2.4 Type scale
| Role | Size / weight | Notes |
|---|---|---|
| Hero decision word | 48–64px / 800 | with a coloured text-shadow glow |
| Big metric | 28–30px / 800 | conviction %, review % |
| Section title (`.dtitle`) | 22–24px / 800 | centred, `letter-spacing:.04em` |
| Body | 13–14px / 1.4–1.55 | |
| Row label (`.clbl`, `h2`) | 10–11px / 600, `letter-spacing:.18em`, UPPERCASE, `--dim` | the workhorse label |
| Tag / pill | 9px / 800, `letter-spacing:.05–.08em` | |
| Micro-meta | 8.5–10px | session, timestamps, axis labels |

Letter-spacing rule of thumb: **the smaller the text, the wider the tracking** (9px → `.08em`, 12px brand → `.38em`).

### 2.5 Geometry & spacing
- Radii: **22px** hero · **16px** card · **12px** button/banner · **9–11px** input/chip · **5–6px** tag.
- Card padding `14px 15px`; hero `16px 18px 18px`; gaps 6–14px.
- Page gutter 14px, content `max-width:520px` centred (mobile stays comfortable on tablets).
- Hairlines: `1px solid var(--line)`; separators inside lists use `border-top` with `:first-child{border-top:none}`.

---

## 3. Motion

Three ambient animations, all slow, all optional (respect `prefers-reduced-motion` when porting):

```css
/* 1 · breathing glow — intensity driven by a 0..1 confidence variable */
.hero{--g:.5}                     /* set per item in JS */
@keyframes breathe{
  0%,100%{box-shadow:0 0 0 1px color-mix(in srgb,var(--acc) calc(15% + var(--g)*32%),transparent),
                     0 0 calc(14px + var(--g)*40px) -8px color-mix(in srgb,var(--acc) calc(22% + var(--g)*50%),transparent)}
  50%    {box-shadow:0 0 0 1px color-mix(in srgb,var(--acc) calc(26% + var(--g)*54%),transparent),
                     0 0 calc(28px + var(--g)*66px) -6px color-mix(in srgb,var(--acc) calc(38% + var(--g)*58%),transparent)}
}
/* 2 · pulse — live/online dot */
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(47,191,122,.5)}70%{box-shadow:0 0 0 7px rgba(47,191,122,0)}100%{box-shadow:0 0 0 0 rgba(47,191,122,0)}}
/* 3 · radar — passive monitoring indicator */
@keyframes radar{0%{transform:scale(.2);opacity:.7}100%{transform:scale(1);opacity:0}}
```

**Confidence-driven glow** is a signature move: map a 0–1 score to `--g` so high-conviction items visibly bloom and low-conviction ones stay calm.
```js
const g = Math.max(0.05, Math.min(1, (confidencePct - 40) / 40));  // 40%→dim, 80%→max
```
Transitions: sheets `.28s cubic-bezier(.4,0,.2,1)`, carousel `.32s` same curve. Nothing faster than 200ms, nothing slower than 350ms for user-initiated motion.

---

## 4. Layout & navigation

### 4.1 Mobile shell
```
┌ header (brand + live status dot)
├ <section id=view1>  ← only one visible; others .hidden
├ <section id=view2>
├ <section id=view3>
├ #sheet  (full-screen overlay, slides up)
└ nav     (fixed bottom, 3 tabs, safe-area padded)
```
- Body padding: `env(safe-area-inset-top) 0 calc(64px + env(safe-area-inset-bottom))` — always respect the notch/home-indicator.
- Tabs swap `.hidden` on sections and `.on` on buttons; scroll resets to top on switch.

### 4.2 The drill-down sheet (core pattern)
One reusable full-screen overlay + a **navigation stack**, giving unlimited depth with a single Back button:

```js
let navStack=[];
function openSheet(title){ $("shtitle").textContent=title; $("sheet").classList.add("on"); $("shbody").scrollTop=0; }
function closeSheet(){ $("sheet").classList.remove("on"); navStack=[]; }
$("shback").onclick=()=>{ navStack.pop(); const t=navStack[navStack.length-1];
  if(!t) return closeSheet();
  t.type==="asset" ? renderAsset(t.id) : renderDetail(t.key); };
```
**Gotcha worth porting (cost me a bug):** the sheet reuses one scroll container, so **every render must reset `scrollTop=0`** — set it in `openSheet` *and* immediately after each `innerHTML=` assignment. Otherwise a shorter view swaps in while scrolled down and appears blank.

### 4.3 Swipeable carousel
Track of `min-width:100%` slides, translated by index; dots + a hint line beneath.
```js
el.addEventListener("touchstart",e=>{x0=e.touches[0].clientX;y0=e.touches[0].clientY;},{passive:true});
el.addEventListener("touchend",e=>{ const dx=e.changedTouches[0].clientX-x0, dy=e.changedTouches[0].clientY-y0;
  if(Math.abs(dx)>42 && Math.abs(dx)>Math.abs(dy)) go(dx<0?1:-1); },{passive:true});
```
Threshold **42px** with a horizontal-dominance check so vertical page scroll still wins. Container gets `touch-action:pan-y`.

---

## 5. Component library

| Component | Purpose | Key traits |
|---|---|---|
| **Hero card** | The one answer | Accent glow scaled by confidence, giant decision word, big %, segmented bar, 2–3 stat columns, meta footer |
| **Segmented bar** | Confidence as discrete units | ~26–32 `<i>` blocks; filled ones get `background:var(--acc)` + small glow. Reads faster than a continuous bar |
| **Card** | Generic surface | `--card` bg, hairline, 16px radius, `.clbl` label on top |
| **List row** | Scannable index | Circular icon (colour = state) + name + tag pill + right-aligned value + `›` chevron; `:active{opacity:.6}` |
| **Tag pill** | State/category | 9px/800, colour-mixed background: `color-mix(in srgb,var(--acc) 16%,transparent)` |
| **Chip** | Qualitative note | bordered, tinted variants: neutral / bull / bear / warn |
| **Stat row (`.drow`)** | Label→value pairs | `justify-content:space-between`, value bold + tabular, bottom hairline |
| **Banner** | Blocked/closed state | Tinted bg + matching border, centred, explains *why* and *when it changes* |
| **Bottom nav** | 3 tabs max | Inline SVG stroke icons (`stroke:currentColor`), label under icon, `.on` = `--info` |
| **Micro-chart** | Trend at a glance | Inline SVG, `viewBox="0 0 100 100"` + `preserveAspectRatio="none"`, `vector-effect:non-scaling-stroke` |

### 5.1 Segmented confidence bar
```js
const seg=28, on=Math.round(pct/100*seg);
const bar=Array.from({length:seg},(_,i)=>`<i class="${i<on?"on":""}"></i>`).join("");
```
```css
.segbar{display:flex;gap:2.5px;justify-content:center}
.segbar i{width:6px;height:14px;border-radius:1.5px;background:#1b2730}
.segbar i.on{background:var(--acc);box-shadow:0 0 6px -1px var(--acc)}
```

### 5.2 Interactive data-map (the "Level Ladder" pattern)
A dense reference chart that stays **clip-art simple until touched**. Generalises to any "values on a vertical scale" visual.

- Draw structure in a stretched SVG (`preserveAspectRatio="none"`), but put **text labels in absolutely-positioned HTML** on top — stretched SVG text distorts.
- Faint background lines (opacity .14, dashed) for reference levels; solid/tinted bands for the active item; dashed lines for boundaries.
- **Press-and-hold / hover** snaps a guide line to the nearest datum and shows a tooltip with its detail.

```js
const move = clientY => {
  const r = el.getBoundingClientRect();
  const y = Math.max(0, Math.min(r.height, clientY - r.top));
  const value = max - (y / r.height) * (max - min);
  let best=null, bd=Infinity;
  levels.forEach(l=>{ const d=Math.abs(l.p-value); if(d<bd){bd=d;best=l;} });
  /* position guide + tooltip at best */
};
el.addEventListener("touchmove", e=>{ move(e.touches[0].clientY); e.preventDefault(); }, {passive:false});
el.addEventListener("mousemove", e=>move(e.clientY));
```
Container needs `touch-action:none`; always provide the mouse pair so it works on desktop too.

---

## 6. State vocabulary

Every tracked entity resolves to exactly one state, which drives icon + colour + sort order. Rename to fit the domain, keep the shape:

| State | Colour | Icon | Meaning | Sort |
|---|---|---|---|---|
| WINDOW / LIVE | decision colour | ↓ ↑ | actionable **now** | 0 |
| ARMED | decision colour | ↓ ↑ | ready, waiting on a trigger | 1 |
| WATCH | `--info` | ◉ | monitored, not actionable | 2 |
| SLEEPING | `--sleep` | · | nothing here | 3 |
| CLOSED | `--sleep` | ☾ | unavailable right now (+ when it returns) | 4 |

**Sorting rule:** availability → urgency → proximity → confidence. Actionable items always float to the top; unavailable ones sink but stay visible (never hide them — absence is ambiguous).

---

## 7. Interaction rules

- **Gate destructive/committing actions behind real state.** Action buttons only exist when the action is genuinely valid (right state *and* available); otherwise show a banner explaining what unlocks them. Never render a disabled button with no explanation.
- **Classify the user's input, don't just store it.** When a user reports a value, immediately compare it to the plan and label it (e.g. EARLY / PRECISE / LATE) so they get feedback, not just a receipt.
- **Every list row is a drill-down.** If it's in a list, tapping it opens detail. Chevrons signal it; `:active{opacity:.6}` confirms the tap.
- **Refresh silently.** Poll every 30s, re-render in place, keep the open sheet in sync — never yank the user's position or flash the screen.
- **Tap the status line to force a refresh** — a discoverable, zero-chrome manual retry.
- Inputs need `-webkit-user-select:text` (the app-wide `user-select:none` that stops long-press selection will otherwise break them), plus `inputmode="decimal"` for numerics.
- `-webkit-tap-highlight-color:transparent` globally; provide your own `:active` feedback.

---

## 8. Cross-surface parity (architectural, not cosmetic)

The most valuable lesson in this build: **two surfaces that author their own data will silently drift.** Ours showed different numbers for the same item, and the divergence was invisible until a user caught it.

**Rule: one surface authors, a server extracts, both render.**

```
Rich authored data (in the desktop file)
        │  extracted at request time (cached by mtime)
        ▼
   /api/analysis   ← enriched with live state (stage, price, timing, session, age)
        ├── desktop renders the literal
        └── mobile renders the served copy   → parity guaranteed by construction
```

Implementation notes that mattered:
- Extract with `vm.runInContext` over the pure-data region; cache on file `mtime`. No duplication, no sync step, no build.
- The endpoint **enriches, never mutates** — derived values only (state, proximity, age). Identical inputs ⇒ identical text on both surfaces.
- Give every item a **stable composite key** (`ASSET#index`) and include its parent id **on the child object**. Omitting the parent id was a real bug: the detail view crashed on `parentById(undefined).prop`, rendering nothing while navigation state still advanced — the classic "it looks like nothing happened but Back needs two presses". **Make child renderers derive the parent from the key defensively.**

### Cache-busting (ship this early)
A stale service worker will convince you your fix didn't work. For a tiny same-origin app, always serve fresh and stamp the build:
```js
res.writeHead(200,{ "Content-Type":"text/html; charset=utf-8",
  "Cache-Control":"no-store, no-cache, must-revalidate", "Pragma":"no-cache", "Expires":"0" });
// inject: a visible build id + navigator.serviceWorker.getRegistrations().then(rs=>rs.forEach(r=>r.unregister()))
```
Show the build id **in the UI** (e.g. `SYSTEM ONLINE · b786407`) so "is the new code actually loaded?" is answerable at a glance.

---

## 9. Content & copy voice

- **Imperative and specific**: "WAIT FOR ENTRY", "don't chase", "Reopens Sun 21:00 UTC" — never "Please wait" or "No data available".
- **State the consequence, not the status**: "RUNNING — moved without you" beats "Active".
- Labels UPPERCASE + tracked; sentences sentence-case.
- **Never let the UI imply a recommendation it can't stand behind.** Surface conditions and let the human decide; include the standing disclaimer where decisions are made.
- Use `·` as the inline separator, `—` for asides, `✕` for invalidation, `✓/✗` for logged outcomes, `☾` for closed, `●` for live.

---

## 10. Porting checklist

1. Copy the token blocks (§2) — rename decision colours to your domain's verbs.
2. Adopt the **colour-means-decision** rule and audit every existing use of colour against it.
3. Build the shell: header, sections, bottom nav, sheet + `navStack` (§4.2) — remember `scrollTop=0`.
4. Add hero + segmented bar + `--acc` + confidence glow (§3, §5.1).
5. Define your state vocabulary and its sort order (§6).
6. Build list → detail drill-downs; every row tappable.
7. Add the interactive data-map if you have reference values (§5.2).
8. **Set up the single-source endpoint before you build the second surface** (§8) — retrofitting parity is far more expensive.
9. Add no-store + build stamp on day one.
10. Verify by *executing* render functions against a DOM shim (below), not by eyeballing.

### Headless render test (catches the invisible-crash class of bug)
```js
const mk=id=>({id,innerHTML:"",textContent:"",scrollTop:0,style:{setProperty(){}},
  classList:{add(){},remove(){},toggle(){}},querySelectorAll:()=>[],addEventListener(){},
  getBoundingClientRect:()=>({top:0,height:300}),dataset:{}});
const els={}; global.document={getElementById:id=>els[id]||(els[id]=mk(id)),
  querySelectorAll:()=>[],querySelector:()=>({onclick:null}),documentElement:{style:{setProperty(){}}}};
eval(scriptSource + "\n;DATA=globalThis.__P; globalThis.__render=renderDetail;");
keys.forEach(k=>{ const b=els.shbody; b.innerHTML=""; globalThis.__render(k);
  console.log(b.innerHTML.length>800 ? "✓" : "✗", k); });
```
> Note: `let` inside a direct `eval` is eval-scoped — inject your fixture **inside** the eval string, or every assertion silently fails.

---

## Connects to
- `Dimitry Mobile — UI-UX Guide.md` — the end-user/tester guide (how to *use* it)
- `Dimitry Mobile.html` — reference implementation (mobile)
- `Dimitry Dashboard.html` — reference implementation (desktop)
- `dimitry-server/analysis-source.js` + `/api/analysis` — the single-source extractor (§8)
