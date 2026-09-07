# WLED Status Bridge

A standalone Node.js script that mirrors ncSender machine status to WLED
**continuously, with no dialog open** — bypassing the ncSender plugin
sandbox's lack of outbound network access by connecting directly to
ncSender's own WebSocket and REST API (the same ones the browser UI uses).

Your existing "WLED Status Light" plugin dialog remains the place you
configure settings (WLED host, colors, brightness, X-follower, job
completion effect). This script just reads that same saved configuration
and acts on it in the background.

Two settings work identically here and in the dialog:

- **Idle auto-off** — turns every configured WLED instance off after N
  minutes of continuous idle. Fires once per idle period; resumes normally
  (lights back on) as soon as the machine leaves idle again.
- **Additional WLED instances** — extra hosts that mirror the same status
  colors as the primary, but never get the X-axis follower segments (the
  follower is primary-only, since secondary strips may be a different
  length or serve a different purpose).

## Requirements

- Node.js installed on the same PC as ncSender ([nodejs.org](https://nodejs.org) — LTS version is fine)
- ncSender running with its Remote Control Port reachable (default `8090`)

## Setup

1. Copy this `wled-bridge` folder anywhere on the CNC PC (e.g. `C:\wled-bridge`)
2. Open a terminal/Command Prompt in that folder and run:
   ```
   npm install
   ```
3. Start it:
   ```
   node wled-bridge.js
   ```
4. You should see:
   ```
   2026-08-27T... [wled-bridge] starting — ncSender expected at localhost:8090
   2026-08-27T... [wled-bridge] connected to ncSender WebSocket at localhost:8090
   ```
5. Jog the machine — the console should print `applyColor run ok`, `applyColor idle ok`, etc. as the state changes, and the WLED strip should follow along, with ncSender's own dialog completely closed.

If your ncSender "Remote Control Port" setting isn't the default `8090`,
open `wled-bridge.js` and change the `NCSENDER_PORT` constant near the top
to match.

## Running it automatically (Windows)

To have this start automatically whenever you log in, without needing a
terminal window open:

1. Press `Win + R`, type `taskschd.msc`, press Enter (Task Scheduler)
2. Click **Create Task...** (not "Basic Task") in the right-hand panel
3. **General tab**: name it `WLED Status Bridge`; select "Run whether user is logged on or not" if you want it hidden, or "Run only when user is logged on" if a console window is fine
4. **Triggers tab** → New... → Begin the task: **At log on**
5. **Actions tab** → New... → Action: **Start a program**
   - Program/script: `node`
   - Add arguments: `wled-bridge.js`
   - Start in: the full path to this folder, e.g. `C:\wled-bridge`
6. **Conditions tab**: uncheck "Start the task only if the computer is on AC power" if this is a laptop
7. Save, then log off/on (or right-click the task → Run) to test

To stop it: find the task in Task Scheduler and click **Disable** or
**End**, or just close the console window if you ran it manually.

## Troubleshooting

- **"failed to load plugin settings"** — check `NCSENDER_PORT` matches your
  actual Remote Control Port (Settings in ncSender), and that ncSender is
  running.
- **WebSocket keeps reconnecting** — same as above; also confirm no firewall
  is blocking localhost traffic on that port.
- **Settings not taking effect** — this script re-reads settings every 5
  seconds, so changes made in the dialog should show up within that window
  without restarting the script.
- **Strip doesn't respond, but "applyColor ... ok" prints** — WLED accepted
  the request, so check the WLED device itself (power, correct hostname/IP,
  segment count matching your actual LED strip length).
