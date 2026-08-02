# Dimitry — a local trading-intelligence engine

Dimitry is a **zero-dependency, single-machine** trading-analysis brain: a small Node
server that turns authored market analysis into live, state-aware setups and serves
them to a desktop dashboard and a phone app. It watches beliefs, scores its own calls,
reconciles what you actually did against what it planned, and learns from the gap.

> **Educational only — not financial advice.** Dimitry never places orders. Execution
> is human-only; the operator owns every decision and all capital.

---

## What's in this repository

This is a **code-only** repo. All personal and financial data — beliefs, fills,
executions, the journal, account balances, and the data-bearing desktop dashboard —
is deliberately **excluded** (see `.gitignore`) and never leaves the operator's machine.

```
50_Training/Tools/
├─ dimitry-server/            # the engine (pure Node built-ins, no npm install)
│  ├─ server.js               #   HTTP server + API + single-source /api/analysis
│  ├─ analysis-source.js      #   extracts the authored analysis, served to web ⇄ mobile
│  ├─ journal-parse.js        #   free text → structured, linked journal facts
│  ├─ belief-store.js         #   append-only, decaying, superseded-never-overwritten
│  ├─ watchers/               #   opportunity · contradiction · macro · confluence · watch-manager
│  ├─ rules/                  #   invalidator · engine · reconcile · worker (closing the loop)
│  ├─ calibration/            #   base-rates · ascent (self-model / EQ) — logic only
│  ├─ doctor.js               #   self-diagnostics
│  └─ users.example.json      #   template for multi-user access (copy → users.json)
├─ Dimitry Mobile.html        # the phone app ("Commander") — a pure renderer, no data
├─ Dimitry — UI-UX Design System.md
└─ Dimitry Mobile — UI-UX Guide.md
```

The desktop `Dimitry Dashboard.html` is **not** in the repo: it embeds live account
figures inline. Keep it local (or commit a sanitized template if you want the UI shared).

---

## Run it

```bash
cd 50_Training/Tools/dimitry-server
node server.js                 # → http://localhost:8848  (dashboard)  ·  /m  (phone app)
```

No build, no dependencies — Node 18+ only. `node doctor.js` runs the self-diagnostics.

---

## Architecture (one idea worth stealing)

**One surface authors, the server extracts, both render.** The desktop dashboard is the
single authoring source of analysis; the server extracts that object at request time and
serves it at `/api/analysis`, enriched with live state (stage, price, session, age). The
mobile app renders the *same* served object — so the two can never show different numbers.
See `Dimitry — UI-UX Design System.md` §8 for the full pattern.

Data flow: `authored analysis → watchers → belief store → risk gating → decision`, with a
reconciliation loop (`setup → intent → fill → outcome`) that measures execution leaks and
feeds the self-model.

---

## Multi-user access (optional)

By default the server is single-user and open on your private network. To grant others
access, copy `users.example.json → users.json` (gitignored) and give each person a token:

```json
[
  { "token": "long-random-string-1", "name": "izuosi",  "role": "owner" },
  { "token": "long-random-string-2", "name": "tester1", "role": "full" },
  { "token": "long-random-string-3", "name": "tester2", "role": "view" }
]
```

- **owner / full** — can read and log (executions, journal). Writes are tagged with the user.
- **view** — read-only; logging is disabled.

Share access privately over Tailscale — never expose the server on the open internet.
See `Dimitry — Access & Sharing.md` for the step-by-step.

---

## License

Private. All rights reserved unless a `LICENSE` file says otherwise.
