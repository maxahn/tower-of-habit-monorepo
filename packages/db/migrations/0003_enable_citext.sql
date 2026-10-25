-- Custom SQL migration file, put your code below! --
-- citext backs users.email (case-insensitive unique + lookups). Trusted on
-- PG13+, so the database owner can create it without superuser.
CREATE EXTENSION IF NOT EXISTS citext;
