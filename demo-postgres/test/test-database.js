"use strict";

const { Pool } = require("pg");
const { migrate } = require("../db");
const { promisify } = require("node:util");
const crypto = require("node:crypto");
const scrypt = promisify(crypto.scrypt);

function validatedTestUrl() {
  if (process.env.NODE_ENV === "production") throw new Error("Tests are disabled when NODE_ENV=production");
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) throw new Error("TEST_DATABASE_URL is required; tests will not fall back to DATABASE_URL");
  if (process.env.ALLOW_TEST_DATABASE_RESET !== "YES") {
    throw new Error("Set ALLOW_TEST_DATABASE_RESET=YES only for a dedicated disposable local test database");
  }
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("TEST_DATABASE_URL is not a valid PostgreSQL URL");
  }
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  if (!localHosts.has(url.hostname) || !/(^|[-_])test($|[-_])/.test(databaseName)) {
    throw new Error("TEST_DATABASE_URL must target a local database with 'test' in its name");
  }
  if (process.env.DATABASE_URL) {
    let productionUrl;
    try {
      productionUrl = new URL(process.env.DATABASE_URL);
    } catch {
      throw new Error("DATABASE_URL is invalid; refusing to run destructive test setup");
    }
    const canonicalHost = (hostname) => ["localhost", "127.0.0.1", "::1"].includes(hostname) ? "loopback" : hostname.toLowerCase();
    const targetPort = url.port || "5432";
    const productionPort = productionUrl.port || "5432";
    if (canonicalHost(url.hostname) === canonicalHost(productionUrl.hostname)
      && targetPort === productionPort
      && url.pathname === productionUrl.pathname) {
      throw new Error("TEST_DATABASE_URL matches DATABASE_URL; refusing destructive test setup");
    }
  }
  return connectionString;
}

async function prepareTestDatabase() {
  const connectionString = validatedTestUrl();
  const pool = new Pool({
    connectionString,
    max: 2,
    ssl: process.env.TEST_PGSSL === "disable" ? false : undefined,
  });
  const client = await pool.connect();
  try {
    const identity = await client.query("SELECT current_database() AS name, current_setting('transaction_read_only') AS read_only");
    const parsed = new URL(connectionString);
    const expectedName = decodeURIComponent(parsed.pathname.slice(1));
    if (identity.rows[0].name !== expectedName || identity.rows[0].read_only !== "off") {
      throw new Error("Connected PostgreSQL identity does not match the validated disposable test database");
    }
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public");
  } catch (error) {
    client.release();
    await pool.end();
    throw error;
  }
  client.release();
  await migrate(pool);
  return pool;
}

async function seedAccount(pool, username, role) {
  const salt = crypto.randomBytes(16);
  const password = "Disposable-Test-Password-2026!";
  const key = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const encoded = `scrypt$${salt.toString("base64url")}$${key.toString("base64url")}`;
  const result = await pool.query(
    "INSERT INTO users(username,display_name,password_hash,role) VALUES($1,$2,$3,$4) RETURNING id",
    [username, `Test ${role}`, encoded, role],
  );
  return { id: result.rows[0].id, username, password };
}

module.exports = { prepareTestDatabase, seedAccount, validatedTestUrl };
