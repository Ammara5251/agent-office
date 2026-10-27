#!/usr/bin/env bash
# Start Agent Office (Linux / macOS). Env: PORT (3004), HOST (127.0.0.1), ARCHIVE_DAYS (3).
set -euo pipefail
cd "$(dirname "$0")"
if ! command -v node >/dev/null; then echo "Node.js 22.5+ is required: https://nodejs.org" >&2; exit 1; fi
exec node --no-warnings server.js
