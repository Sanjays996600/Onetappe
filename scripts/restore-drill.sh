#!/usr/bin/env bash
# Restore drill: dumps a database, restores the dump into a scratch database and proves the
# copy is complete and still protected (append-only history, no-overlap constraints,
# least-privilege runtime role). Prints how long dump and restore took.
#
#   scripts/restore-drill.sh <source-database-url> [scratch-database-name]
#
# The scratch database is dropped and re-created; its name must contain "drill". Run it
# against a production backup only on the isolated restore host (docs/07).
set -euo pipefail

SOURCE_URL=${1:?usage: restore-drill.sh <source-database-url> [scratch-database-name]}
DRILL=${2:-onetappe_restore_drill}
[[ "$DRILL" == *drill* ]] || { echo "Refusing: the scratch database name must contain 'drill'"; exit 2; }

SERVER_URL=$(node -e 'const u=new URL(process.argv[1]); u.pathname="/postgres"; console.log(u.toString())' "$SOURCE_URL")
DRILL_URL=$(node -e 'const u=new URL(process.argv[1]); u.pathname="/"+process.argv[2]; console.log(u.toString())' "$SOURCE_URL" "$DRILL")
DUMP=$(mktemp -t onetappe-drill.XXXXXX.dump)
trap 'rm -f "$DUMP"' EXIT

q() { psql "$1" -v ON_ERROR_STOP=1 -Atqc "$2"; }
fail() { echo "RESTORE DRILL FAILED: $*"; exit 1; }

t0=$(date +%s)
pg_dump --format=custom --file="$DUMP" "$SOURCE_URL"
t1=$(date +%s)
psql "$SERVER_URL" -v ON_ERROR_STOP=1 -qc "DROP DATABASE IF EXISTS $DRILL WITH (FORCE)" -c "CREATE DATABASE $DRILL"
pg_restore --exit-on-error --no-owner --dbname="$DRILL_URL" "$DUMP"
t2=$(date +%s)

# 1. Every table has the same number of rows, and key tables the same content.
COUNTS="SELECT string_agg(format('%s=%s', table_name,
          (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I', table_name), false, true, '')))[1]::text), ',' ORDER BY table_name)
        FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'"
[[ "$(q "$SOURCE_URL" "$COUNTS")" == "$(q "$DRILL_URL" "$COUNTS")" ]] || fail "row counts differ"
for table in booking payment audit_log booking_status_history safety_incident_event; do
  SUM="SELECT coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), 'empty') FROM $table t"
  [[ "$(q "$SOURCE_URL" "$SUM")" == "$(q "$DRILL_URL" "$SUM")" ]] || fail "$table content differs"
done

# 2. Schema, triggers and constraints came across.
for check in \
  "SELECT count(*) FROM schema_migration" \
  "SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal" \
  "SELECT count(*) FROM pg_constraint WHERE connamespace = 'public'::regnamespace"; do
  [[ "$(q "$SOURCE_URL" "$check")" == "$(q "$DRILL_URL" "$check")" ]] || fail "differs: $check"
done
[[ "$(q "$DRILL_URL" "SELECT count(*) FROM pg_constraint WHERE conname = 'worker_reservation_no_overlap'")" == 1 ]] \
  || fail "the double-booking exclusion constraint is missing"

# 3. Protections still hold on the copy.
if psql "$DRILL_URL" -qc "UPDATE audit_log SET reason = 'tampered' WHERE id = (SELECT min(id) FROM audit_log)" 2>/dev/null \
   && [[ "$(q "$DRILL_URL" "SELECT count(*) FROM audit_log")" != 0 ]]; then
  fail "audit_log accepted an UPDATE"
fi
[[ "$(q "$DRILL_URL" "SELECT has_table_privilege('onetappe_app', 'audit_log', 'UPDATE')")" == f ]] \
  || fail "the runtime role can modify the audit log"
[[ "$(q "$DRILL_URL" "SELECT has_table_privilege('onetappe_app', 'booking', 'TRUNCATE')")" == f ]] \
  || fail "the runtime role can truncate bookings"

psql "$SERVER_URL" -qc "DROP DATABASE $DRILL WITH (FORCE)"
echo "RESTORE DRILL PASSED: dump $((t1 - t0))s, restore $((t2 - t1))s, $(stat -c %s "$DUMP") bytes"
