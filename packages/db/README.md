### Dev Cheat Sheet

**Connect to database from host:**
(Check your `.env.dev` or active .env. file for the correct user and database)

```bash
docker exec -it <container_name> psql -U tower -d tower_dev
```

Postgres common commands:

`\l` List databases
`\c database_name` Connect to a database
`\dt` List tables in the current schema
`\dt *.*` List tables across schemas
`\d table_name` Show table columns and indexes
`SELECT * FROM table_name LIMIT 10;` View table contents
`\q` Exit psql
