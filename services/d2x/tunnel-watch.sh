#!/bin/sh
set -eu

# Tunnel replicas alone do not probe the local origin. Remove this replica from
# rotation whenever the local converter is unavailable.
if /usr/bin/python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8765/health', timeout=3)" >/dev/null 2>&1; then
  if [ -s /etc/genoffice-d2x/credentials.json ]; then
    systemctl start genoffice-d2x-tunnel.service
  fi
else
  systemctl stop genoffice-d2x-tunnel.service
fi
