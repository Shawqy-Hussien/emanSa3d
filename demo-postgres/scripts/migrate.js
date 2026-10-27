"use strict";

const { closePool, getPool, migrate } = require("../db");

(async () => {
  try {
    await migrate();
    console.log("PostgreSQL migrations are current.");
  } finally {
    await closePool();
  }
})().catch((error) => {
  console.error("Database migration failed:", error.message);
  process.exitCode = 1;
});
