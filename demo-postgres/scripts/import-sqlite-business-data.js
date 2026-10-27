"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync, backup } = require("node:sqlite");
const { closePool, getPool } = require("../db");

function countBusinessRows(database) {
  const pharmacies = database.prepare("SELECT COUNT(*) AS count FROM pharmacies").get().count;
  const transactions = database.prepare("SELECT COUNT(*) AS count FROM transactions").get().count;
  return { pharmacies, transactions };
}

async function createVerifiedBackup(sourcePath, backupPath) {
  if (!fs.existsSync(sourcePath)) throw new Error("SQLite source database does not exist");
  if (path.resolve(sourcePath) === path.resolve(backupPath)) throw new Error("Backup path must differ from the SQLite source");
  if (fs.existsSync(backupPath)) throw new Error("Backup destination already exists; choose a new path");
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });

  const source = new DatabaseSync(sourcePath, { readOnly: true });
  let sourceCounts;
  try {
    const check = source.prepare("PRAGMA integrity_check").get();
    if (check.integrity_check !== "ok") throw new Error("SQLite source integrity check failed");
    sourceCounts = countBusinessRows(source);
    await backup(source, backupPath);
  } finally {
    source.close();
  }

  const copy = new DatabaseSync(backupPath, { readOnly: true });
  try {
    const check = copy.prepare("PRAGMA integrity_check").get();
    if (check.integrity_check !== "ok") throw new Error("SQLite backup integrity check failed");
    const backupCounts = countBusinessRows(copy);
    if (JSON.stringify(sourceCounts) !== JSON.stringify(backupCounts)) {
      throw new Error("SQLite backup verification count mismatch");
    }
    return sourceCounts;
  } finally {
    copy.close();
  }
}

function validateDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

async function importBusinessData() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const projectDirectory = path.resolve(__dirname, "..");
  const sourcePath = path.resolve(projectDirectory, process.env.SQLITE_SOURCE_PATH || "../data/pharmacy.sqlite");
  const backupPath = path.resolve(projectDirectory, process.env.DEMO_BACKUP_PATH || "./local/pharmacy-source-backup.sqlite");
  const verifiedCounts = await createVerifiedBackup(sourcePath, backupPath);
  console.log(`SQLite backup created and verified. Business rows: ${verifiedCounts.pharmacies} pharmacies, ${verifiedCounts.transactions} transactions.`);

  const source = new DatabaseSync(backupPath, { readOnly: true });
  const database = getPool();
  const client = await database.connect();
  let transactionStarted = false;
  try {
    const pharmacies = source.prepare("SELECT id, name, location, created_at FROM pharmacies ORDER BY id").all();
    const transactions = source.prepare(`
      SELECT id, pharmacy_id, type, amount, date, description, payment_method, created_at
      FROM transactions ORDER BY id
    `).all();
    if (pharmacies.length !== verifiedCounts.pharmacies || transactions.length !== verifiedCounts.transactions) {
      throw new Error("Business record count changed after backup verification");
    }
    for (const record of transactions) {
      if (!validateDate(record.date)) throw new Error("Source contains a transaction date that PostgreSQL cannot safely import");
    }

    await client.query("BEGIN");
    transactionStarted = true;
    const tables = await client.query(`
      SELECT to_regclass('public.pharmacies') AS pharmacies,
             to_regclass('public.transactions') AS transactions,
             to_regclass('public.users') AS users,
             to_regclass('public.sessions') AS sessions
    `);
    if (Object.values(tables.rows[0]).some((table) => !table)) {
      throw new Error("Apply the PostgreSQL schema migration before importing");
    }
    const targetTables = await client.query(`
      SELECT schemaname, tablename FROM pg_tables
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
        AND schemaname !~ '^pg_'
        AND NOT (schemaname = 'public' AND tablename = 'schema_migrations')
      ORDER BY schemaname, tablename
    `);
    for (const { schemaname, tablename } of targetTables.rows) {
      const quotedSchema = `"${schemaname.replaceAll('"', '""')}"`;
      const quotedTable = `"${tablename.replaceAll('"', '""')}"`;
      await client.query(`LOCK TABLE ${quotedSchema}.${quotedTable} IN ACCESS EXCLUSIVE MODE`);
    }
    for (const { schemaname, tablename } of targetTables.rows) {
      const quotedSchema = `"${schemaname.replaceAll('"', '""')}"`;
      const quotedTable = `"${tablename.replaceAll('"', '""')}"`;
      const count = await client.query(`SELECT count(*) AS count FROM ${quotedSchema}.${quotedTable}`);
      if (BigInt(count.rows[0].count) !== 0n) {
        throw new Error("Target database contains records; import aborted without changes");
      }
    }

    for (const pharmacy of pharmacies) {
      await client.query(
        "INSERT INTO pharmacies(id,name,location,created_at) VALUES ($1,$2,$3,$4::timestamp AT TIME ZONE 'UTC')",
        [pharmacy.id, pharmacy.name, pharmacy.location, pharmacy.created_at],
      );
    }
    for (const transaction of transactions) {
      await client.query(
        `INSERT INTO transactions(id,pharmacy_id,type,amount,date,description,payment_method,created_at)
         VALUES ($1,$2,$3,$4,$5::date,$6,$7,$8::timestamp AT TIME ZONE 'UTC')`,
        [transaction.id, transaction.pharmacy_id, transaction.type, String(transaction.amount), transaction.date,
          transaction.description, transaction.payment_method, transaction.created_at],
      );
    }
    for (const table of ["pharmacies", "transactions"]) {
      await client.query(
        `SELECT setval(pg_get_serial_sequence($1, 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1), EXISTS (SELECT 1 FROM ${table}))`,
        [table],
      );
    }
    const imported = await client.query(`
      SELECT (SELECT count(*) FROM pharmacies) AS pharmacies,
             (SELECT count(*) FROM transactions) AS transactions
    `);
    if (BigInt(imported.rows[0].pharmacies) !== BigInt(verifiedCounts.pharmacies)
      || BigInt(imported.rows[0].transactions) !== BigInt(verifiedCounts.transactions)) {
      throw new Error("Imported business record counts failed verification");
    }
    const orphaned = await client.query(`
      SELECT count(*) AS count FROM transactions t LEFT JOIN pharmacies p ON p.id=t.pharmacy_id
      WHERE p.id IS NULL
    `);
    if (BigInt(orphaned.rows[0].count) !== 0n) throw new Error("Imported transaction relationship verification failed");
    await client.query("COMMIT");
    transactionStarted = false;
    console.log(`Business data import verified: ${verifiedCounts.pharmacies} pharmacies, ${verifiedCounts.transactions} transactions.`);
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original import failure.
      }
    }
    throw error;
  } finally {
    source.close();
    client.release();
    await closePool();
  }
}

if (require.main === module) {
  importBusinessData().catch((error) => {
    console.error("SQLite business-data import failed:", error.message);
    process.exitCode = 1;
  });
}

module.exports = { createVerifiedBackup, importBusinessData };
