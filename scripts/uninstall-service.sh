#!/bin/bash
launchctl bootout "gui/$(id -u)/com.signaldesk.agent" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/com.signaldesk.agent.plist"
echo "Signal Desk service removed."
