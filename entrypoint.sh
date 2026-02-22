#!/bin/sh
set -e

mkdir -p /app/data /app/uploads

exec node /app/apps/web/server.js
