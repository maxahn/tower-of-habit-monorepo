#!/bin/sh
set -e

# Only runs on a fresh pgdata volume (docker-entrypoint-initdb.d convention).
# If you already have a pgdata volume from before this existed, create the
# database by hand once: docker compose exec postgres psql -U "$POSTGRES_USER" -c "CREATE DATABASE tower_test;"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-SQL
    CREATE DATABASE tower_test;
SQL
