#!/bin/bash
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js isn't installed."
  echo "Get it free at https://nodejs.org (choose the LTS version), then double-click this file again."
  read -p "Press Enter to close..."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Setting up (first run only, this takes a minute or two)..."
  npm install
fi

if [ ! -f .env ]; then
  node setup.js
fi

echo ""
echo "Starting KinRead..."
echo "Your browser will open to http://localhost:3000 in a few seconds."
( sleep 2 && open http://localhost:3000 ) &
npm start
