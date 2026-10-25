#!/bin/bash
# Installs Signal Desk as a macOS LaunchAgent: starts at login, restarts if it dies.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
PLIST="$HOME/Library/LaunchAgents/com.signaldesk.agent.plist"
mkdir -p "$HOME/Library/LaunchAgents" "$DIR/data"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.signaldesk.agent</string>
  <key>ProgramArguments</key><array><string>/usr/bin/caffeinate</string><string>-is</string><string>$NODE</string><string>--no-warnings</string><string>$DIR/src/main.js</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$DIR/data/desk.log</string>
  <key>StandardErrorPath</key><string>$DIR/data/desk.log</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string></dict>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/com.signaldesk.agent" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Signal Desk installed → http://localhost:${PORT:-4777}  (logs: $DIR/data/desk.log)"
