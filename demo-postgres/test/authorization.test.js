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
let viewer;
let adminCookie;
let viewerCookie;

async function login(account) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: baseUrl },
    body: JSON.stringify({ username: account.username, password: account.password }),
  });
  return response.headers.get("set-cookie").split(";")[0];
}

before(async () => {
  pool = await prepareTestDatabase();
  admin = await seedAccount(pool, "role-admin", "admin");
  viewer = await seedAccount(pool, "role-viewer", "user");
  server = createHttpServer(pool);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  adminCookie = await login(admin);
  viewerCookie = await login(viewer);
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
});

test("viewer can read data but cannot perform admin operations", async () => {
  const read = await fetch(`${baseUrl}/api/pharmacies`, { headers: { Cookie: viewerCookie } });
  assert.equal(read.status, 200);
  const create = await fetch(`${baseUrl}/api/pharmacies`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: baseUrl, Cookie: viewerCookie },
    body: JSON.stringify({ name: "Viewer Must Not Create" }),
  });
  assert.equal(create.status, 403);
});

test("admin can create and delete pharmacy and transaction records", async () => {
  const pharmacyResponse = await fetch(`${baseUrl}/api/pharmacies`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: baseUrl, Cookie: adminCookie },
    body: JSON.stringify({ name: "Admin-created Pharmacy" }),
  });
  assert.equal(pharmacyResponse.status, 201);
  const pharmacy = await pharmacyResponse.json();
  const transactionResponse = await fetch(`${baseUrl}/api/transactions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: baseUrl, Cookie: adminCookie },
    body: JSON.stringify({
      pharmacyId: pharmacy.id, type: "sale", amount: 14.25, date: "2026-10-21",
      description: "disposable test", paymentMethod: "cash",
    }),
  });
  assert.equal(transactionResponse.status, 201);
  const transaction = await transactionResponse.json();
  assert.equal((await fetch(`${baseUrl}/api/dashboard`, { headers: { Cookie: viewerCookie } })).status, 200);
  const deleted = await fetch(`${baseUrl}/api/pharmacies/${pharmacy.id}`, {
    method: "DELETE",
    headers: { Origin: baseUrl, Cookie: adminCookie },
  });
  assert.equal(deleted.status, 200);
  const verifyCascade = await pool.query("SELECT count(*) AS count FROM transactions WHERE id=$1", [transaction.id]);
  assert.equal(Number(verifyCascade.rows[0].count), 0);
});
