# Dimitry — App Setup (Phase 0 + PWA)

Turns the dashboard into an app you install on your PC and phone, served from your
laptop. Leave the laptop on; reach it anywhere via Tailscale.

**Not financial advice.**

---

## What this is

- `server.js` — a tiny zero-dependency Node server. Serves the dashboard as an installable
  app and exposes the vault over `/api/vault` (sandboxed to the Trading folder).
- `manifest.webmanifest`, `sw.js`, `icon.svg` — the PWA (Progressive Web App) files that
  make it installable and give it an offline shell.

Nothing to `npm install`. It uses only built-in Node.

---

## One-time setup

### 1. Install Node (if you don't have it)
Download the LTS from https://nodejs.org and install. Check it worked:
```
node --version
```

### 2. Start the server
Open a terminal in this folder and run:
```
node server.js
```
You'll see:
```
DIMITRY server running
├─ local  : http://localhost:8848
```
Open **http://localhost:8848** in Chrome/Edge on the PC. The cockpit loads.

> Keep this terminal open — closing it stops the server. (Auto-start on boot: see the
> bottom of this file.)

### 3. Install it as a PC app
In Chrome/Edge at `http://localhost:8848`, click the **Install** icon in the address bar
(or ⋮ menu → *Install Dimitry*). It gets its own window and a desktop/taskbar icon.

---

## Reach it from your phone (Tailscale)

Service workers / PWA install need **HTTPS**. Tailscale gives you both a private network
*and* an HTTPS URL, for free.

### 4. Install Tailscale on both devices
- Laptop: https://tailscale.com/download → sign in (Google/Microsoft/GitHub).
- Phone: same app from the App Store / Play Store → sign in with the **same account**.

Both devices now share one private network. Nothing is exposed to the public internet.

### 5. Expose the server over HTTPS on your tailnet
On the laptop, with `node server.js` already running, open a **second** terminal:
```
tailscale serve --bg https / http://localhost:8848
```
Then run:
```
tailscale serve status
```
It prints an `https://<your-laptop>.<your-tailnet>.ts.net/` URL.

### 6. Open that URL on your phone
With Tailscale connected on the phone, open the `https://…ts.net` URL in the phone browser
→ **Add to Home Screen** (Safari) / **Install app** (Chrome). You now have the Dimitry app
icon on your phone, reachable from anywhere as long as the laptop is on and connected.

---

## Optional: lock it with a token

By default the API is open to anything on your tailnet (already private). To add a shared
secret, start the server like this instead:

- Windows PowerShell:
  ```
  $env:DIMITRY_TOKEN="pick-a-long-random-string"; node server.js
  ```
Then append `?token=pick-a-long-random-string` when the app calls the vault API.

---

## Optional: auto-start on boot (so you don't have to remember)

Simplest reliable way on Windows — a scheduled task:
1. Open **Task Scheduler** → *Create Basic Task*.
2. Trigger: **When I log on**.
3. Action: *Start a program* → Program: `node` → Arguments: `server.js` →
   Start in: this folder's full path.
4. Finish. Now the server starts whenever you log in.

(Later we can replace this with a proper Tauri desktop app that runs the server for you.)

---

## Health check

- `http://localhost:8848/api/health` → `{ ok:true, ... }` means the server is alive.
- The dashboard's own ⟳ refresh button and the EKG freshness indicator tell you whether
  live data is flowing.

---

## What's next (Phase 1b)

Right now the dashboard still pulls market data directly in the browser (works fine over
Tailscale — your phone has its own internet). The next upgrade is to route **vault reads
and journal writes** through `/api/vault` so the app can read your analyses and record
trades to the laptop from the phone. Say the word and I'll wire the client side to the API.

## Connects to
- [[Dimitry Dashboard]] · [[Trade Campaigns — Continuation Entries & Stop Ladders]]
