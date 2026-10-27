"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { before, after } = test;
const { prepareTestDatabase } = require("./test-database");

let pool;

before(async () => {
  pool = await prepareTestDatabase();
});

after(async () => {
  if (pool) await pool.end();
});

test("migrations create constrained pharmacy business tables", async () => {
  const pharmacy = await pool.query(
    "INSERT INTO pharmacies(name,location) VALUES($1,$2) RETURNING id",
    ["Test Pharmacy", "Test Location"],
  );
  const pharmacyId = pharmacy.rows[0].id;
  const inserted = await pool.query(
    `INSERT INTO transactions(pharmacy_id,type,amount,date,description,payment_method)
     VALUES($1,'sale',12.50,'2026-10-21','test row','cash') RETURNING id`,
    [pharmacyId],
  );
  assert.ok(inserted.rows[0].id);
  await assert.rejects(
    pool.query("INSERT INTO transactions(pharmacy_id,type,amount,date) VALUES($1,'invalid',1,'2026-10-21')", [pharmacyId]),
    { code: "23514" },
  );
  await pool.query("DELETE FROM pharmacies WHERE id=$1", [pharmacyId]);
  const remaining = await pool.query("SELECT count(*) AS count FROM transactions WHERE id=$1", [inserted.rows[0].id]);
  assert.equal(Number(remaining.rows[0].count), 0);
});

test("username uniqueness is case insensitive", async () => {
  await pool.query("INSERT INTO users(username,display_name,password_hash,role) VALUES('UniqueUser','Unique','placeholder','user')");
  await assert.rejects(
    pool.query("INSERT INTO users(username,display_name,password_hash,role) VALUES('uniqueuser','Duplicate','placeholder','user')"),
    { code: "23505" },
  );
});
