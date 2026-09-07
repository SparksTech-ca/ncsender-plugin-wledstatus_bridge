# Running the WLED Status Bridge as a Background Service

This guide covers installing Node.js and setting up `wled-bridge.js` to start
automatically and run continuously in the background, on Windows, macOS, and
Linux.

Throughout this guide, replace `/path/to/wled-bridge` (or `C:\wled-bridge` on
Windows) with wherever you've actually copied the `bridge` folder.

---

## 1. Install Node.js

You need Node.js installed on the same machine that runs ncSender.

### Windows
Download the **LTS** installer from [nodejs.org](https://nodejs.org) and run
it. Leave "Add to PATH" checked (it's on by default). Verify in a new
Command Prompt:
```
node --version
```

### macOS
Easiest via [Homebrew](https://brew.sh):
```bash
brew install node
```
Or download the official `.pkg` installer from [nodejs.org](https://nodejs.org).
Verify:
```bash
node --version
```

### Linux
Use your distro's package manager, or [NodeSource](https://github.com/nodesource/distributions)
for a more current version:
```bash
# Debian/Ubuntu, via NodeSource (recommended - distro repos are often outdated)
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt install -y nodejs

# Fedora
sudo dnf install nodejs

# Arch
sudo pacman -S nodejs npm
```
Verify:
```bash
node --version
```

---

## 2. Set up the bridge

Copy the `bridge` folder somewhere stable:

| OS | Suggested location |
|---|---|
| Windows | `C:\wled-bridge` |
| macOS | `/usr/local/wled-bridge` or `~/wled-bridge` |
| Linux | `/opt/wled-bridge` or `~/wled-bridge` |

Then install dependencies:
```bash
cd /path/to/wled-bridge
npm install
```

**Test it manually first**, before setting up a service — confirm you see it
connect and apply colors while jogging:
```bash
node wled-bridge.js
```
Press `Ctrl+C` to stop. Once this works, move on to making it run
automatically.

---

## 3. Running as a service

Pick the approach for your OS below.

### Windows — Option A: Task Scheduler (simplest)

No extra tools needed; runs a visible or hidden console process at login.

1. Press `Win + R`, type `taskschd.msc`, press Enter
2. **Create Task...** (not "Basic Task")
3. **General tab**: Name it `WLED Status Bridge`. Choose "Run whether user is
   logged on or not" for a fully hidden service, or "Run only when user is
   logged on" if a console window is fine
4. **Triggers tab** → New... → Begin the task: **At log on**
5. **Actions tab** → New... → Action: **Start a program**
   - Program/script: `node`
   - Add arguments: `wled-bridge.js`
   - Start in: `C:\wled-bridge`
6. **Conditions tab**: uncheck "Start only if on AC power" if this is a laptop
7. Save. Right-click the task → **Run** to test, or log off/on

To stop: find the task in Task Scheduler and **Disable** or **End**.

### Windows — Option B: NSSM (real Windows Service, auto-restart on crash)

[NSSM](https://nssm.cc/) installs Node scripts as proper Windows Services —
useful if you want automatic restart on crash and no dependency on a user
being logged in at all.

1. Download NSSM from [nssm.cc](https://nssm.cc/download), extract, and use
   the `win64\nssm.exe` (or `win32`) binary
2. Open an **elevated** Command Prompt (Run as Administrator) in the folder
   containing `nssm.exe`:
   ```
   nssm install WledStatusBridge
   ```
3. A GUI opens:
   - **Path**: the full path to `node.exe` (find it with `where node`)
   - **Startup directory**: `C:\wled-bridge`
   - **Arguments**: `wled-bridge.js`
   - On the **I/O** tab, optionally set stdout/stderr log file paths
     (e.g. `C:\wled-bridge\bridge.log`)
4. Click **Install service**
5. Start it:
   ```
   nssm start WledStatusBridge
   ```
6. Set it to auto-start at boot (usually the default), or check with:
   ```
   nssm set WledStatusBridge Start SERVICE_AUTO_START
   ```

To manage it later:
```
nssm stop WledStatusBridge
nssm restart WledStatusBridge
nssm remove WledStatusBridge confirm
```

### macOS — launchd

macOS uses `launchd` for background services. A **LaunchAgent** (per-user,
no `sudo` needed, starts at login) is the right choice here.

1. Create the file `~/Library/LaunchAgents/com.sparkstech.wledbridge.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.sparkstech.wledbridge</string>

    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/usr/local/wled-bridge/wled-bridge.js</string>
    </array>

    <key>WorkingDirectory</key>
    <string>/usr/local/wled-bridge</string>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>/usr/local/wled-bridge/bridge.log</string>

    <key>StandardErrorPath</key>
    <string>/usr/local/wled-bridge/bridge-error.log</string>
</dict>
</plist>
```

   Adjust the `node` path (find yours with `which node` — Homebrew on Apple
   Silicon typically installs to `/opt/homebrew/bin/node`) and the script
   path to match where you actually copied things.

2. Load and start it:
   ```bash
   launchctl load ~/Library/LaunchAgents/com.sparkstech.wledbridge.plist
   launchctl start com.sparkstech.wledbridge
   ```

3. Check it's running:
   ```bash
   launchctl list | grep wledbridge
   tail -f /usr/local/wled-bridge/bridge.log
   ```

To stop/remove:
```bash
launchctl stop com.sparkstech.wledbridge
launchctl unload ~/Library/LaunchAgents/com.sparkstech.wledbridge.plist
```

`KeepAlive` set to `true` means launchd restarts it automatically if it
crashes, and `RunAtLoad` means it starts automatically the next time you log in.

### Linux — systemd

A **user service** (no root required, starts at login) is simplest. If you'd
rather it run even when nobody's logged in, use a **system service** instead
(the alternate block below).

**User service** (recommended for a desktop/workstation PC):

1. Create `~/.config/systemd/user/wled-bridge.service`:

```ini
[Unit]
Description=WLED Status Bridge
After=network.target

[Service]
ExecStart=/usr/bin/node /opt/wled-bridge/wled-bridge.js
WorkingDirectory=/opt/wled-bridge
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

   Adjust `ExecStart`'s node path if needed (`which node`) and the script path.

2. Enable and start it:
   ```bash
   systemctl --user daemon-reload
   systemctl --user enable --now wled-bridge
   ```

3. So it can start even without an active login session:
   ```bash
   loginctl enable-linger $USER
   ```

4. Check status and logs:
   ```bash
   systemctl --user status wled-bridge
   journalctl --user -u wled-bridge -f
   ```

**System-wide service** (starts at boot, no login needed at all) — use this
instead if ncSender itself runs headless/always-on:

1. Create `/etc/systemd/system/wled-bridge.service`:

```ini
[Unit]
Description=WLED Status Bridge
After=network.target

[Service]
ExecStart=/usr/bin/node /opt/wled-bridge/wled-bridge.js
WorkingDirectory=/opt/wled-bridge
Restart=on-failure
RestartSec=5
User=your-username

[Install]
WantedBy=multi-user.target
```

   Set `User=` to the account that should own the process (needed since
   system services otherwise run as root).

2. Enable and start it:
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now wled-bridge
   ```

3. Check status and logs:
   ```bash
   sudo systemctl status wled-bridge
   sudo journalctl -u wled-bridge -f
   ```

---

## 4. Quick command reference

| Action | Windows (NSSM) | macOS (launchd) | Linux (systemd, user) |
|---|---|---|---|
| Start | `nssm start WledStatusBridge` | `launchctl start com.sparkstech.wledbridge` | `systemctl --user start wled-bridge` |
| Stop | `nssm stop WledStatusBridge` | `launchctl stop com.sparkstech.wledbridge` | `systemctl --user stop wled-bridge` |
| Restart | `nssm restart WledStatusBridge` | stop then start | `systemctl --user restart wled-bridge` |
| Status | Services app (`services.msc`) | `launchctl list \| grep wledbridge` | `systemctl --user status wled-bridge` |
| Logs | NSSM I/O tab log file | `tail -f bridge.log` (path set in plist) | `journalctl --user -u wled-bridge -f` |
| Disable autostart | `nssm remove WledStatusBridge confirm` | `launchctl unload <plist path>` | `systemctl --user disable wled-bridge` |

---

## 5. Troubleshooting

- **Service starts then immediately exits** — run `node wled-bridge.js`
  manually in a terminal first; service wrappers often hide the actual error.
  Check that `npm install` completed successfully in that folder.
- **"failed to load plugin settings"** — confirm `NCSENDER_PORT` in
  `wled-bridge.js` matches ncSender's actual Remote Control Port, and that
  ncSender is running before the service starts.
- **Works manually but not as a service** — double-check the working
  directory / `WorkingDirectory` setting points at the folder containing
  `wled-bridge.js` and its `node_modules`, since services often don't
  inherit the same working directory a terminal session has.
- **Windows Task Scheduler task doesn't start at login** — make sure the
  trigger is "At log on" for your specific user account, not a different
  trigger type, and that "Start in" is set under the Action.
