#!/usr/bin/env bash
# Start the ree web app in development mode
set -e

cd "$(dirname "$0")/apps/web"

echo "Starting ree dev server at http://localhost:3000"
echo ""
echo "Before running, make sure apps/web/.env.local has:"
echo "  TWITCH_CLIENT_SECRET=<your secret>"
echo "  NEXTAUTH_URL=http://localhost:3000  (or your IP)"
echo ""

pnpm dev
