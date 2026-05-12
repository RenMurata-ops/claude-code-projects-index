#!/bin/bash
# Foreground launcher for the local control panel.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
exec /Users/renmurata/.bun/bin/bun run "$DIR/server.ts"
