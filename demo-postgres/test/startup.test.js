"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { before, after } = test;
const { prepareTestDatabase } = require("./test-database");
const { closePool } = require("../db");
const { startServer } = require("../server");

let pool;
let server;
const previousDatabaseUrl = process.env.DATABASE_URL;
const previousPgSsl = process.env.PGSSL;

before(async () => {
  pool = await prepareTestDatabase();
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  if (process.env.TEST_PGSSL === "disable") process.env.PGSSL = "disable";
  server = await startServer({ port: 0, host: "127.0.0.1" });
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  await closePool();
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
  if (previousPgSsl === undefined) delete process.env.PGSSL;
  else process.env.PGSSL = previousPgSsl;
});

test("application starts and exposes PostgreSQL readiness and static frontend", async () => {
  const address = server.address();
  const health = await fetch(`http://127.0.0.1:${address.port}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok", database: "postgresql" });
  const homepage = await fetch(`http://127.0.0.1:${address.port}/`);
  assert.equal(homepage.status, 200);
  assert.match(homepage.headers.get("content-type"), /text\/html/);
});
