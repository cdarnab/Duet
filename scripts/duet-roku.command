#!/bin/bash
# Double-click this on a Mac on the same Wi-Fi as the Roku. Leave the window open.
cd "$(dirname "$0")/.." || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

echo "Duet · Roku"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is missing. Install it from https://nodejs.org then double-click this again."
  read -r -p "Press Return to close. "
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Installing Duet dependencies once…"
  npm install
fi

node agent/index.js --device roku "$@" || {
  echo
  read -r -p "Press Return to close. "
  exit 1
}
