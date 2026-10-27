"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");
const { closePool, getPool } = require("../db");

const scrypt = promisify(crypto.scrypt);

async function passwordHash(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

async function createDemoAccounts() {
  const credentialsPath = path.resolve(__dirname, "../local/generated-demo-credentials.json");
  if (fs.existsSync(credentialsPath)) throw new Error("Credential file already exists; refusing to overwrite");
  fs.mkdirSync(path.dirname(credentialsPath), { recursive: true });
  const credentials = [
    { username: "demo-admin", displayName: "Demo Administrator", role: "admin", password: crypto.randomBytes(24).toString("base64url") },
    { username: "demo-viewer", displayName: "Demo Viewer", role: "user", password: crypto.randomBytes(24).toString("base64url") },
  ];
  const database = getPool();
  const client = await database.connect();
  let created = false;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [74120622]);
    const state = await client.query("SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM sessions) AS sessions");
    if (BigInt(state.rows[0].users) !== 0n || BigInt(state.rows[0].sessions) !== 0n) {
      throw new Error("Demo account bootstrap requires an empty users and sessions set");
    }
    for (const account of credentials) {
      await client.query(
        "INSERT INTO users(username,display_name,password_hash,role) VALUES ($1,$2,$3,$4)",
        [account.username, account.displayName, await passwordHash(account.password), account.role],
      );
    }
    await client.query("COMMIT");
    created = true;
    const content = `${JSON.stringify(credentials.map(({ username, displayName, role, password }) => ({
      username, displayName, role, password,
    })), null, 2)}\n`;
    fs.writeFileSync(credentialsPath, content, { flag: "wx", mode: 0o600 });
    console.log("Fresh demo admin and viewer accounts were created. Credentials are stored in the ignored local credential file.");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original bootstrap failure.
    }
    if (created) {
      await client.query("DELETE FROM users WHERE username IN ('demo-admin','demo-viewer')");
    }
    throw error;
  } finally {
    client.release();
    await closePool();
  }
}

if (require.main === module) {
  createDemoAccounts().catch((error) => {
    console.error("Demo account bootstrap failed:", error.message);
    process.exitCode = 1;
  });
}

module.exports = { createDemoAccounts, passwordHash };
