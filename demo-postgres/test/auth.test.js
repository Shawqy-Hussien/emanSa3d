"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { before, after } = test;
const { prepareTestDatabase, seedAccount } = require("./test-database");
const { createHttpServer } = require("../server");

let pool;
let server;
let baseUrl;
let admin;

before(async () => {
  pool = await prepareTestDatabase();
  admin = await seedAccount(pool, "auth-admin", "admin");
  server = createHttpServer(pool);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
});

test("login creates a secure-session-capable cookie and authenticated status", async () => {
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: baseUrl },
    body: JSON.stringify({ username: admin.username, password: admin.password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  const status = await fetch(`${baseUrl}/api/auth/status`, { headers: { Cookie: cookie.split(";")[0] } });
  assert.equal(status.status, 200);
  assert.equal((await status.json()).user.role, "admin");
});

test("invalid login fails and public first-admin setup stays disabled", async () => {
  const badLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: baseUrl },
    body: JSON.stringify({ username: admin.username, password: "wrong" }),
  });
  assert.equal(badLogin.status, 401);
  const setup = await fetch(`${baseUrl}/api/auth/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: baseUrl },
    body: "{}",
  });
  assert.equal(setup.status, 403);
});
