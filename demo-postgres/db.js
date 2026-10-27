"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { Pool } = require("pg");

const migrationDirectory = path.join(__dirname, "migrations");
let pool;

function pgConnectionString(connectionString) {
  const url = new URL(connectionString);
  for (const option of ["ssl", "sslmode", "sslrootcert", "sslcert", "sslkey"]) {
    url.searchParams.delete(option);
  }
  return url.toString();
}

function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
    if (process.env.NODE_ENV === "production" && process.env.PGSSL === "disable") {
      throw new Error("TLS cannot be disabled for the production PostgreSQL connection");
    }
    pool = new Pool({
      connectionString: pgConnectionString(process.env.DATABASE_URL),
      max: Number(process.env.PG_POOL_MAX || 5),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: true },
    });
    pool.on("error", (error) => console.error("Unexpected idle PostgreSQL client error:", error.message));
  }
  return pool;
}

async function migrate(database = getPool()) {
  const client = await database.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [74120621]);
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
    const migrations = (await fs.readdir(migrationDirectory))
      .filter((file) => /^\d+_[a-z0-9_-]+\.sql$/.test(file))
      .sort();

    for (const file of migrations) {
      const alreadyApplied = await client.query("SELECT 1 FROM schema_migrations WHERE version = $1", [file]);
      if (alreadyApplied.rowCount) continue;
      const sql = await fs.readFile(path.join(migrationDirectory, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [74120621]);
    } finally {
      client.release();
    }
  }
}

async function closePool() {
  if (!pool) return;
  const currentPool = pool;
  pool = undefined;
  await currentPool.end();
}

module.exports = { closePool, getPool, migrate };
