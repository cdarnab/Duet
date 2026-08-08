#!/bin/bash
# Double-click this on the Mac next to the Capsule. Leave the window open.
cd "$(dirname "$0")/.." || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

echo "Duet · Capsule"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is missing. Install it from https://nodejs.org then double-click this again."
  read -r -p "Press Return to close. "
  exit 1
fi

if ! command -v adb >/dev/null 2>&1; then
  echo "ADB is missing. In Terminal run:"
  echo "  brew install android-platform-tools"
  read -r -p "Press Return to close. "
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Installing Duet dependencies once…"
  npm install
fi

node agent/index.js --device nebula "$@" || {
  echo
  read -r -p "Press Return to close. "
  exit 1
}
