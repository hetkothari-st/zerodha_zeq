#!/usr/bin/env bash
# Verifies the auth_profiles migration against a throwaway Docker Postgres
# container stubbed with the minimal parts of Supabase's auth schema.
# This never touches a real Supabase project.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

STUB_SQL="$SCRIPT_DIR/local-supabase-stub.sql"
MIGRATIONS_DIR="$REPO_ROOT/supabase/migrations"
CHECK_SQL="$SCRIPT_DIR/auth_profiles_check.sql"

CONTAINER_NAME="funnel-auth-check-$$-$(date +%s)"
PGPASSWORD="postgres"

# Windows/Git Bash mangles Docker's Unix-style paths and flags; avoid the
# problem entirely by copying no paths into the container args and disabling
# MSYS path conversion for all docker invocations.
export MSYS_NO_PATHCONV=1

cleanup() {
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> Starting throwaway postgres:15 container ($CONTAINER_NAME)"
docker run -d --name "$CONTAINER_NAME" \
    -e POSTGRES_PASSWORD="$PGPASSWORD" \
    postgres:15 >/dev/null

echo "==> Waiting for Postgres to be ready"
for i in $(seq 1 60); do
    if docker exec "$CONTAINER_NAME" pg_isready -U postgres >/dev/null 2>&1; then
        echo "    ready after ${i}s"
        break
    fi
    if [ "$i" -eq 60 ]; then
        echo "FAIL: Postgres did not become ready in time" >&2
        exit 1
    fi
    sleep 1
done

run_sql_file() {
    local label="$1"
    local file="$2"
    echo "==> Running $label"
    if ! docker exec -i "$CONTAINER_NAME" psql -v ON_ERROR_STOP=1 -U postgres < "$file"; then
        echo "FAIL: $label failed" >&2
        exit 1
    fi
}

run_sql_file "Supabase stub (local-supabase-stub.sql)" "$STUB_SQL"

# Apply every migration in supabase/migrations, in name order (they're timestamp-prefixed),
# so the check runs against the schema exactly as it will exist after `supabase db push`.
for migration in "$MIGRATIONS_DIR"/*.sql; do
    run_sql_file "migration ($(basename "$migration"))" "$migration"
done

run_sql_file "check script (auth_profiles_check.sql)" "$CHECK_SQL"

run_sql_file "check script (billing_check.sql)" "$SCRIPT_DIR/billing_check.sql"

echo "==> All steps completed successfully"
