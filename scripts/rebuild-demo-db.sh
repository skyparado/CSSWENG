#!/usr/bin/env bash
# Wipe the database named by DATABASE_URL, rebuild its tables, and load the demo data.
# Takes a few minutes at most. Use it on a fresh or expired free Render database,
# or to get a clean local demo. It DESTROYS everything in that database.
#
#   DATABASE_URL="postgres://..." ./scripts/rebuild-demo-db.sh          # asks you to confirm
#   DATABASE_URL="postgres://..." ./scripts/rebuild-demo-db.sh --yes    # no prompt (scripts)
#
# Needs: psql, node 20, and `npm ci` already run. For Render, use the database's
# EXTERNAL connection string (Render dashboard > clinic-db > Connections).
# The same FIELD_ENCRYPTION_KEY, BLIND_INDEX_KEY and PRISMA_FIELD_ENCRYPTION_KEY the
# web service uses must be set in this shell, or the seeded data will not be readable
# by the site. Load them from backend/.env or export them first. The S3_* settings
# must be set too, because the sample images are uploaded to object storage.
set -euo pipefail

cd "$(dirname "$0")/.."

: "${DATABASE_URL:?Set DATABASE_URL to the database you want to rebuild}"
for k in FIELD_ENCRYPTION_KEY BLIND_INDEX_KEY PRISMA_FIELD_ENCRYPTION_KEY; do
  if [ -z "${!k:-}" ] && ! grep -qs "^$k=" backend/.env; then
    echo "Missing $k. Export it (same value as the web service) or put it in backend/.env." >&2
    exit 1
  fi
done

host=$(printf '%s' "$DATABASE_URL" | sed -E 's#^[a-z]+://[^@]*@([^/:?]+).*#\1#')
echo "About to ERASE all data in the database on host: $host"
if [ "${1:-}" != "--yes" ]; then
  read -r -p "Type RESET to continue: " answer
  [ "$answer" = "RESET" ] || { echo "Cancelled."; exit 1; }
fi

echo "1/3 Dropping and recreating the public schema..."
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
SQL

echo "2/3 Applying migrations..."
npm run prisma:migrate:deploy --workspace backend

echo "3/3 Loading demo data (new random passwords are printed below, once)..."
# NODE_ENV=production here only makes the seed require DEMO_SEED=true, which we set.
NODE_ENV=production DEMO_SEED=true npm run db:seed:demo --workspace backend

echo "Done. Check: curl \$SITE_URL/health/ready"
