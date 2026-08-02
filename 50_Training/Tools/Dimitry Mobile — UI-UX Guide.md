---
title: "Dimitry Commander — Mobile UI/UX Guide"
type: guide
domain: 50_Training/Tools
created: 2026-08-01
updated: 2026-08-01
status: living
tags: [mobile, ui, ux, guide, commander, testing]
---

# Dimitry Commander — mobile guide

> **What this is.** A phone-first cockpit for the Dimitry trading brain. The desktop dashboard answers *why*; this app answers **what do I do right now?** — in one glance. It reads live data from the Dimitry server; it does **not** place trades. **Educational only, not financial advice — you own every decision and all capital.**

## Getting in
1. The Dimitry server must be running on the operator's machine.
2. On your phone, open the server URL with **`/m`** on the end — e.g. `https://<the-tailscale-name>.ts.net/m`.
3. **Add to Home Screen** (iPhone: Share → *Add to Home Screen*; Android: ⋮ → *Add to Home screen*). It opens full-screen like a native app and refreshes itself every 30 seconds.
4. The green dot under **DIMITRY** = **SYSTEM ONLINE** (connected). If it's red, the server isn't reachable — tap the status line to retry.

## The one rule of colour
Colour only ever means a **decision**. Everything else is greyscale.
- 🟢 **Green** — long / buy
- 🔴 **Red** — short / sell
- 🟡 **Amber** — wait
- 🔵 **Blue** — information (state, brain)
- ⚪ **Grey** — sleeping / market closed

## The three tabs (bottom bar)

### 1 · Overview — the cockpit
Top to bottom:

- **Hero card** — the single most important thing: today's decision. It shows the highest-conviction live setup: the **asset**, a huge **SHORT / LONG** word in the decision colour, the **conviction %**, a **Zone** and **Invalidation**, and the **next scan** countdown. If nothing is worth trading it flips to a big amber **PROTECT CAPITAL**. The card glows gently in the decision's colour — that glow *is* the signal.
- **Current State** — one line: the macro regime (e.g. "dollar bid · risk-off") and a confidence. The pulsing radar dot just means the system is live.
- **Watchlist** — one compact row per asset: a coloured icon, the asset, a status tag, its lean, and a conviction %. Sorted so the actionable ones float to the top.
- **Brain** — the system's self-measurement: **EQ** (its self-improvement/consistency index), the **mode**, **efficiency %**, and a heartbeat line showing it's alive.

### 2 · Setups — every play at a glance
A list of all live setups. Tap any one to open its **detail** (same screen described below).

### 3 · Journal — log your trades
Upload a **screenshot, broker PDF/CSV, or a typed note**. Dimitry extracts the fills, R, and any skips on its next pass and files it. The **Recent uploads** list shows each as **PENDING → FILED**. This is how the record stays honest — log what you actually did.

## Watchlist statuses
| Tag | Icon | Meaning |
|---|---|---|
| **ARMED** | ↓ / ↑ | A live directional setup — the actionable ones |
| **WAIT** | – | A directional lean, not yet a trigger |
| **WATCH** | ◉ | Monitoring; low conviction / near 50-50 |
| **SLEEPING** | · | Nothing on this asset |
| **CLOSED** | ☾ | Market closed (FX, metals, indices on the weekend). Crypto is 24/7 |

## Drilling in (tap to explore)
- **Tap an asset** in the Watchlist → its **Asset detail**: bias, macro context, structure notes, and its **Setups (N)** — you'll see whether it has one (PRIMARY) or several.
- **Tap a setup** (from there, or from the Setups tab) → its **Setup detail**.
- **‹ Back** steps you out one level at a time.

## The Setup detail screen
The full plan: the big **direction**, **conviction**, **Zone · Stop · Targets · Size**, the **Invalidation** (what proves it wrong), the **Entry window** (see below), and **The plan** in Dimitry's own words.

### The live Entry window
This updates in real time from the price:
- **WAITING** — price hasn't reached the zone yet. Nothing to do.
- **● ENTRY WINDOW OPEN** — price is *in the zone*. This is the prime moment — wait for your trigger and decide.
- **● CONTINUATION — re-entry open** — the move is running and pulled back; a chance to join it.
- **RUNNING — moved without you** — it left without you. Don't chase; wait for the next pullback or the next setup.

### Logging your execution (only when the window is open)
When the **Entry window is open**, two buttons appear — **✓ I executed** and **✗ Skipped**. (They're hidden otherwise, and on closed markets, so you can only log a real decision.)
- **✓ I executed** opens a short form: your **entry**, **size %**, **stop**, and an optional **📎 attach position screenshot** (same formats as the Journal). When you confirm, Dimitry classifies your entry as **EARLY / PRECISE / LATE** from where you got in versus the zone, and logs it.
- **✗ Skipped** records that you saw an armed setup and passed — this is measured honestly as the *timidity* signal, so the system learns where you leave money on the table.

## A good daily rhythm
1. Glance at the **Hero** — is there a decision? (3 seconds.)
2. If a setup is **ENTRY WINDOW OPEN** and it passes your own checks, act — and tap **I executed** (attach the order screenshot).
3. If you skip an earned setup, tap **Skipped** — honesty is the point.
4. End of day: **Journal** → upload your trade screenshots/CSV so the record reconciles.

Over time the **Brain** card's EQ and efficiency move as your real behaviour (execution quality, skips, cut-early) gets measured — that's Dimitry patching leaks with you.

## Notes for testing
- Weekends: FX, metals (Gold, Silver) and indices (S&P 500, Nasdaq) show **CLOSED** and offer no execution — crypto stays live.
- Silver, S&P 500 and Nasdaq are now fully onboarded (bias, key zones, structure and a primary setup each) and stream live prices when their markets are open — they behave exactly like BTC.
- **Web & mobile now read one shared source** (`/api/analysis`), so the setups, zones, targets and Level Ladder are identical on both. The home hero is **swipeable** across the armed setups on open markets (nearest-to-entry first). Tap the hero or any Setups row to open the asset, then a setup, to see its full plan + Level Ladder · touch-odds — the same detail as the web. The Journal tab now also carries a **Review** summary of how your logged calls played out.
- If a card says **"Can't reach Dimitry"**, the server isn't reachable from your phone — tell the operator.
- **Never** treat any state as an instruction to trade. Dimitry surfaces conditions; the decision, the risk, and the capital are always yours.
