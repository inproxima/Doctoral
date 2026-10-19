#!/bin/zsh
# Start the Doctoral Dissertation Examination app.
cd "$(dirname "$0")"

if [ ! -d node_modules ]; then
  echo "Installing dependencies…"
  npm install
fi

if [ ! -f .env ]; then
  echo "No .env found. Copy .env.example to .env and add your OPENAI_API_KEY."
  exit 1
fi

exec npm start
