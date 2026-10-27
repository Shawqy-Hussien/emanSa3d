const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const { DatabaseSync } = require("node:sqlite");
const scrypt = promisify(crypto.scrypt);

const root = __dirname;
const dataDir = path.join(root, "data");
const databasePath = process.env.DATABASE_PATH ? path.resolve(process.env.DATABASE_PATH) : path.join(dataDir, "pharmacy.sqlite");
fs.mkdirSync(path.dirname(databasePath), { recursive: true });
const db = new DatabaseSync(databasePath);
const publicFiles = new Set(["index.html", "styles.css", "app.js"]);
const sessionCookie = "pharmacy_session";
const sessionLifetime = 12 * 60 * 60 * 1000;
const loginAttempts = new Map();
db.exec("PRAGMA foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS pharmacies (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE CHECK(length(trim(name)) BETWEEN 1 AND 120),
    location TEXT NOT NULL DEFAULT '' CHECK(length(location) <= 200),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY,
    pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK(type IN ('sale','purchase','expense','income','supply','adjustment')),
    amount REAL NOT NULL CHECK(amount > 0),
    date TEXT NOT NULL CHECK(date GLOB '????-??-??'),
    description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 300),
    payment_method TEXT NOT NULL DEFAULT 'cash' CHECK(payment_method IN ('cash','bank','credit')),
    shift_id INTEGER REFERENCES shifts(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS transactions_date_idx ON transactions(date);
  CREATE INDEX IF NOT EXISTS transactions_pharmacy_idx ON transactions(pharmacy_id);
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK(length(username) BETWEEN 3 AND 40),
    display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 100),
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin','branch_manager','user')),
    permissions TEXT NOT NULL DEFAULT '["view_data","record_transactions","close_shifts"]',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
  CREATE TABLE IF NOT EXISTS shifts (
    id INTEGER PRIMARY KEY,
    pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    shift_date TEXT NOT NULL CHECK(shift_date GLOB '????-??-??'),
    start_time TEXT NOT NULL CHECK(start_time GLOB '??:??'),
    end_time TEXT NOT NULL CHECK(end_time GLOB '??:??'),
    notes TEXT NOT NULL DEFAULT '' CHECK(length(notes) <= 300),
    sales_amount REAL CHECK(sales_amount IS NULL OR sales_amount >= 0),
    closed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS shifts_branch_date_idx ON shifts(pharmacy_id,shift_date,start_time);
  CREATE TABLE IF NOT EXISTS pharmacy_shift_templates (
    id INTEGER PRIMARY KEY,
    pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 60),
    start_time TEXT NOT NULL CHECK(start_time GLOB '??:??'),
    end_time TEXT NOT NULL CHECK(end_time GLOB '??:??'),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS pharmacy_shift_templates_branch_idx ON pharmacy_shift_templates(pharmacy_id,start_time);
`);
const shiftColumns = new Set(db.prepare("PRAGMA table_info(shifts)").all().map((column) => column.name));
if (!shiftColumns.has("sales_amount")) {
  db.exec("ALTER TABLE shifts ADD COLUMN sales_amount REAL CHECK(sales_amount IS NULL OR sales_amount >= 0)");
}
if (!shiftColumns.has("closed_at")) {
  db.exec("ALTER TABLE shifts ADD COLUMN closed_at TEXT");
}
const userColumns = new Set(db.prepare("PRAGMA table_info(users)").all().map((column) => column.name));
if (!userColumns.has("pharmacy_id")) {
  db.exec("ALTER TABLE users ADD COLUMN pharmacy_id INTEGER REFERENCES pharmacies(id) ON DELETE SET NULL");
}
if (!userColumns.has("branch_restricted")) {
  db.exec("ALTER TABLE users ADD COLUMN branch_restricted INTEGER NOT NULL DEFAULT 0");
}
const usersTableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get().sql;
if (!usersTableSql.includes("'branch_manager'") || !userColumns.has("permissions")) {
  const permissionsExpression = userColumns.has("permissions")
    ? "permissions"
    : "'[\"view_data\",\"record_transactions\",\"close_shifts\"]'";
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE users_new (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK(length(username) BETWEEN 3 AND 40),
        display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 100),
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin','branch_manager','user')),
        permissions TEXT NOT NULL DEFAULT '["view_data","record_transactions","close_shifts"]',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        pharmacy_id INTEGER REFERENCES pharmacies(id) ON DELETE SET NULL,
        branch_restricted INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO users_new(id,username,display_name,password_hash,role,permissions,created_at,pharmacy_id,branch_restricted)
      SELECT id,username,display_name,password_hash,role,${permissionsExpression},created_at,pharmacy_id,branch_restricted
      FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}
const transactionTableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='transactions'").get().sql;
if (!transactionTableSql.includes("'instapay'")) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE transactions_new (
        id INTEGER PRIMARY KEY,
        pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK(type IN ('sale','purchase','expense','income','supply','adjustment')),
        amount REAL NOT NULL CHECK(amount > 0),
        date TEXT NOT NULL CHECK(date GLOB '????-??-??'),
        description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 300),
        payment_method TEXT NOT NULL DEFAULT 'cash'
          CHECK(payment_method IN ('cash','bank','credit','visa','instapay','vodafon','pharmacy')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO transactions_new(id,pharmacy_id,type,amount,date,description,payment_method,created_at)
      SELECT id,pharmacy_id,type,amount,date,description,payment_method,created_at FROM transactions;
      DROP TABLE transactions;
      ALTER TABLE transactions_new RENAME TO transactions;
      CREATE INDEX transactions_date_idx ON transactions(date);
      CREATE INDEX transactions_pharmacy_idx ON transactions(pharmacy_id);
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
const transactionColumns = new Set(db.prepare("PRAGMA table_info(transactions)").all().map((column) => column.name));
if (!transactionColumns.has("shift_id")) {
  db.exec("ALTER TABLE transactions ADD COLUMN shift_id INTEGER REFERENCES shifts(id) ON DELETE SET NULL");
}
if (!transactionColumns.has("shift_template_id")) {
  db.exec("ALTER TABLE transactions ADD COLUMN shift_template_id INTEGER REFERENCES pharmacy_shift_templates(id) ON DELETE SET NULL");
}
db.exec("CREATE INDEX IF NOT EXISTS transactions_shift_idx ON transactions(shift_id)");
db.exec(`
  CREATE TABLE IF NOT EXISTS transaction_payment_splits (
    transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    payment_method TEXT NOT NULL CHECK(payment_method IN ('cash','visa','instapay','vodafon','pharmacy')),
    amount REAL NOT NULL CHECK(amount > 0),
    PRIMARY KEY(transaction_id,payment_method)
  )
`);
db.exec("CREATE INDEX IF NOT EXISTS transaction_payment_splits_method_idx ON transaction_payment_splits(payment_method)");

const transactionTypeSet = new Set(["sale", "purchase", "expense", "income", "supply", "adjustment"]);
const paymentMethodSet = new Set(["cash", "bank", "credit", "visa", "instapay", "vodafon", "pharmacy"]);
const salePaymentMethodSet = new Set(["cash", "visa", "instapay", "vodafon", "pharmacy"]);
const supplyPaymentMethodSet = new Set(["visa", "instapay", "vodafon", "pharmacy"]);
const permissionSet = new Set(["view_data", "record_transactions", "close_shifts", "manage_shifts", "delete_transactions"]);
const defaultPermissionsByRole = {
  user: ["view_data", "record_transactions", "close_shifts"],
  branch_manager: ["view_data", "record_transactions", "close_shifts", "manage_shifts"],
};
const paymentMethodLabels = {
  cash: "نقدي",
  visa: "فيزا",
  instapay: "إنستاباي",
  vodafon: "فودافون (د/أحمد)",
  pharmacy: "فودافون (صيدلية)",
  bank: "تحويل بنكي",
  credit: "آجل",
};
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    role: user.role,
    pharmacyId: user.pharmacy_id ?? null,
    permissions: user.role === "admin" ? [...permissionSet] : JSON.parse(user.permissions),
  };
}

function hasPermission(user, permission) {
  return user.role === "admin" || JSON.parse(user.permissions || "[]").includes(permission);
}

function readSessionToken(request) {
  const cookieHeader = request.headers.cookie || "";
  for (const cookie of cookieHeader.split(";")) {
    const separator = cookie.indexOf("=");
    if (separator !== -1 && cookie.slice(0, separator).trim() === sessionCookie) {
      return cookie.slice(separator + 1).trim();
    }
  }
  return "";
}

function requestUser(request) {
  const token = readSessionToken(request);
  if (!token || !/^[\w-]{40,60}$/.test(token)) return null;
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const session = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.role, u.pharmacy_id, u.branch_restricted, u.permissions, s.expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?
  `).get(tokenHash);
  if (!session || session.expires_at <= Date.now()) {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
    return null;
  }
  return session;
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derivedKey = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${salt.toString("base64url")}$${derivedKey.toString("base64url")}`;
}

async function verifyPassword(password, encodedHash) {
  const [algorithm, saltText, hashText] = encodedHash.split("$");
  if (algorithm !== "scrypt" || !saltText || !hashText) return false;
  const expected = Buffer.from(hashText, "base64url");
  const actual = await scrypt(password, Buffer.from(saltText, "base64url"), expected.length, {
    N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024,
  });
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function validateAccount(body, { creatingAdmin = false, passwordOptional = false } = {}) {
  const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
  const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!/^[a-z0-9_.-]{3,40}$/.test(username)) {
    throw Object.assign(new Error("اسم المستخدم: 3–40 حرفاً إنجليزياً أو أرقاماً أو . _ -"), { status: 400 });
  }
  if (!displayName || displayName.length > 100) {
    throw Object.assign(new Error("أدخل اسماً ظاهراً لا يتجاوز 100 حرف"), { status: 400 });
  }
  if ((!passwordOptional || password) && (password.length < 12 || password.length > 128)) {
    throw Object.assign(new Error("يجب أن تتكون كلمة المرور من 12 إلى 128 حرفاً"), { status: 400 });
  }
  const role = creatingAdmin
    ? "admin"
    : ["admin", "branch_manager", "user"].includes(body.role) ? body.role : "";
  if (!role) throw Object.assign(new Error("حدد صلاحية الحساب"), { status: 400 });
  const pharmacyId = role === "admin" ? null : Number(body.pharmacyId);
  if (role !== "admin" && (!Number.isSafeInteger(pharmacyId) || pharmacyId < 1)) {
    throw Object.assign(new Error("اختر صيدلية لحساب المستخدم"), { status: 400 });
  }
  const submittedPermissions = body.permissions === undefined
    ? defaultPermissionsByRole[role] || []
    : body.permissions;
  if (!Array.isArray(submittedPermissions) || submittedPermissions.some((permission) => !permissionSet.has(permission))) {
    throw Object.assign(new Error("قائمة الصلاحيات غير صالحة"), { status: 400 });
  }
  return {
    username,
    displayName,
    password: password || "",
    role,
    pharmacyId,
    permissions: role === "admin" ? [...permissionSet] : [...new Set(submittedPermissions)],
  };
}

function allowAttempt(request, action, maximum) {
  const key = `${action}:${request.socket.remoteAddress || "unknown"}`;
  const now = Date.now();
  const previous = loginAttempts.get(key) || { count: 0, startedAt: now };
  if (now - previous.startedAt > 15 * 60 * 1000) {
    previous.count = 0;
    previous.startedAt = now;
  }
  if (previous.count >= maximum) {
    throw Object.assign(new Error("محاولات كثيرة. حاول مرة أخرى بعد 15 دقيقة."), { status: 429 });
  }
  previous.count += 1;
  loginAttempts.set(key, previous);
}

function setSessionCookie(request, response, token) {
  const secure = request.socket.encrypted || process.env.COOKIE_SECURE === "true" ? "; Secure" : "";
  response.setHeader("Set-Cookie", `${sessionCookie}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionLifetime / 1000}${secure}`);
}

function clearSessionCookie(request, response) {
  const secure = request.socket.encrypted || process.env.COOKIE_SECURE === "true" ? "; Secure" : "";
  response.setHeader("Set-Cookie", `${sessionCookie}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
}

function createSession(request, response, userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)").run(
    crypto.createHash("sha256").update(token).digest("hex"),
    userId,
    Date.now() + sessionLifetime,
  );
  setSessionCookie(request, response, token);
}

function assertSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw Object.assign(new Error("مصدر الطلب غير صالح"), { status: 403 });
  }
  if (parsed.host !== request.headers.host) {
    throw Object.assign(new Error("تم رفض الطلب لمصدره غير الموثوق"), { status: 403 });
  }
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1024 * 1024) throw Object.assign(new Error("حجم البيانات أكبر من الحد المسموح"), { status: 413 });
  }
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw Object.assign(new Error("صيغة JSON غير صالحة"), { status: 400 });
  }
}

function validDate(value) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function pharmacyList(user) {
  const where = user.branch_restricted ? "WHERE p.id = ?" : "";
  const values = user.branch_restricted && user.pharmacy_id ? [user.pharmacy_id] : [];
  if (user.branch_restricted && !user.pharmacy_id) return [];
  const pharmacies = db.prepare(`
    SELECT p.id, p.name, p.location,
      COALESCE(SUM(CASE WHEN t.type = 'sale' THEN t.amount ELSE 0 END), 0) +
        COALESCE((SELECT SUM(s.sales_amount) FROM shifts s WHERE s.pharmacy_id=p.id), 0) AS sales,
      COALESCE(SUM(CASE WHEN t.type = 'purchase' THEN t.amount ELSE 0 END), 0) AS purchases,
      COALESCE(SUM(CASE WHEN t.type IN ('income','sale') THEN t.amount WHEN t.type IN ('expense','purchase') THEN -t.amount ELSE 0 END), 0) +
        COALESCE((SELECT SUM(s.sales_amount) FROM shifts s WHERE s.pharmacy_id=p.id), 0) AS balance,
      COUNT(t.id) AS transactionCount
    FROM pharmacies p LEFT JOIN transactions t ON t.pharmacy_id = p.id
    ${where}
    GROUP BY p.id ORDER BY p.name COLLATE NOCASE
  `).all(...values);
  if (!pharmacies.length) return pharmacies;
  const templates = db.prepare(`
    SELECT id,pharmacy_id AS pharmacyId,name,start_time AS startTime,end_time AS endTime
    FROM pharmacy_shift_templates
    WHERE pharmacy_id IN (${pharmacies.map(() => "?").join(",")})
    ORDER BY start_time,id
  `).all(...pharmacies.map((pharmacy) => pharmacy.id));
  const templatesByPharmacy = new Map(pharmacies.map((pharmacy) => [pharmacy.id, []]));
  for (const template of templates) templatesByPharmacy.get(template.pharmacyId).push(template);
  return pharmacies.map((pharmacy) => ({ ...pharmacy, shifts: templatesByPharmacy.get(pharmacy.id) }));
}

function dashboardData(user) {
  const scoped = user.branch_restricted;
  const transactionWhere = scoped && user.pharmacy_id ? "WHERE pharmacy_id = ?" : scoped ? "WHERE 0" : "";
  const pharmacyWhere = scoped && user.pharmacy_id ? "WHERE id = ?" : scoped ? "WHERE 0" : "";
  const values = scoped && user.pharmacy_id ? [user.pharmacy_id] : [];
  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type='sale' THEN amount ELSE 0 END),0) AS sales,
      COALESCE(SUM(CASE WHEN type='purchase' THEN amount ELSE 0 END),0) AS purchases,
      COALESCE(SUM(CASE WHEN type='expense' THEN amount ELSE 0 END),0) AS expenses,
      COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE 0 END),0) AS income,
      COALESCE(SUM(CASE WHEN type='supply' THEN amount ELSE 0 END),0) AS supplies,
      COALESCE(SUM(CASE WHEN type='sale' AND payment_method='credit' THEN amount ELSE 0 END),0) AS creditSales,
      COALESCE(SUM(CASE WHEN date=date('now','localtime') AND type='sale' THEN amount ELSE 0 END),0) AS todaySales,
      COALESCE(SUM(CASE WHEN date=date('now','localtime') AND type='purchase' THEN amount ELSE 0 END),0) AS todayPurchases,
      COALESCE(SUM(CASE WHEN date=date('now','localtime') AND type='expense' THEN amount ELSE 0 END),0) AS todayExpenses,
      COALESCE(SUM(CASE WHEN payment_method='cash' AND type IN ('sale','income','supply') THEN amount WHEN payment_method='cash' AND type IN ('purchase','expense') THEN -amount ELSE 0 END),0) +
        COALESCE(SUM(CASE WHEN type='supply' AND payment_method!='cash' THEN amount ELSE 0 END),0) AS cashBalance,
      COALESCE(SUM(CASE WHEN payment_method='bank' AND type='supply' THEN -amount WHEN payment_method='bank' AND type IN ('sale','income') THEN amount WHEN payment_method='bank' AND type IN ('purchase','expense') THEN -amount ELSE 0 END),0) AS bankBalance,
      COALESCE(SUM(CASE WHEN type IN ('income','sale') THEN amount WHEN type IN ('expense','purchase') THEN -amount ELSE 0 END),0) AS balance
    FROM transactions ${transactionWhere}
  `).get(...values);
  const shiftTotals = db.prepare(`
    SELECT COALESCE(SUM(sales_amount),0) AS sales,
      COALESCE(SUM(CASE WHEN shift_date=date('now','localtime') THEN sales_amount ELSE 0 END),0) AS todaySales
    FROM shifts ${transactionWhere}
  `).get(...values);
  totals.sales += shiftTotals.sales;
  totals.todaySales += shiftTotals.todaySales;
  const paymentBalances = Object.fromEntries([...paymentMethodSet].map((method) => [method, 0]));
  const methodBalances = db.prepare(`
    SELECT method,COALESCE(SUM(amount),0) AS balance FROM (
      SELECT t.payment_method AS method,
        CASE
          WHEN t.type='supply' AND t.payment_method!='cash' THEN -t.amount
          WHEN t.type IN ('sale','income','supply') THEN t.amount
          WHEN t.type IN ('purchase','expense') THEN -t.amount
          ELSE 0
        END AS amount
      FROM transactions t
      WHERE ${scoped ? "t.pharmacy_id=? AND" : ""} (
        t.type!='sale' OR NOT EXISTS (
          SELECT 1 FROM transaction_payment_splits split WHERE split.transaction_id=t.id
        ))
      UNION ALL
      SELECT split.payment_method AS method,split.amount AS amount
      FROM transaction_payment_splits split
      JOIN transactions t ON t.id=split.transaction_id
      ${scoped ? "WHERE t.pharmacy_id=?" : ""}
    )
    GROUP BY method
  `).all(...values, ...(scoped ? values : []));
  for (const row of methodBalances) paymentBalances[row.method] = row.balance;
  paymentBalances.cash += db.prepare(`
    SELECT COALESCE(SUM(amount),0) AS amount
    FROM transactions
    ${transactionWhere ? `${transactionWhere} AND` : "WHERE"} type='supply' AND payment_method!='cash'
  `).get(...values).amount;
  totals.cashBalance = paymentBalances.cash;
  const count = db.prepare(`SELECT COUNT(*) AS count FROM pharmacies ${pharmacyWhere}`).get(...values).count;
  const months = db.prepare(`
    SELECT substr(date,1,7) AS month,
      SUM(CASE WHEN type='sale' THEN amount ELSE 0 END) AS sales,
      SUM(CASE WHEN type='purchase' THEN amount ELSE 0 END) AS purchases
    FROM transactions ${transactionWhere ? `${transactionWhere} AND` : "WHERE"} type IN ('sale','purchase')
    GROUP BY month ORDER BY month DESC LIMIT 7
  `).all(...values);
  const shiftMonths = db.prepare(`
    SELECT substr(shift_date,1,7) AS month,SUM(sales_amount) AS sales
    FROM shifts ${transactionWhere ? `${transactionWhere} AND` : "WHERE"} sales_amount IS NOT NULL
    GROUP BY month ORDER BY month DESC LIMIT 7
  `).all(...values);
  const monthlyTotals = new Map(months.map((month) => [month.month, month]));
  for (const shiftMonth of shiftMonths) {
    const month = monthlyTotals.get(shiftMonth.month) || { month: shiftMonth.month, sales: 0, purchases: 0 };
    month.sales += shiftMonth.sales;
    monthlyTotals.set(shiftMonth.month, month);
  }
  const recentMonths = [...monthlyTotals.values()].sort((left, right) => left.month.localeCompare(right.month)).slice(-7);
  return {
    ...totals,
    revenue: totals.income,
    netSales: totals.sales - totals.purchases,
    purchasePercentage: totals.sales ? totals.purchases / totals.sales * 100 : 0,
    paymentBalances,
    pharmacyCount: count,
    months: recentMonths,
  };
}

function transactionsList(search, user) {
  const conditions = [];
  const values = [];
  if (user.branch_restricted) {
    if (!user.pharmacy_id) conditions.push("0");
    else {
      conditions.push("t.pharmacy_id = ?");
      values.push(user.pharmacy_id);
    }
  }
  const requestedTypes = search.get("type")?.split(",").filter(Boolean);
  if (requestedTypes?.length) {
    if (requestedTypes.some((type) => !transactionTypeSet.has(type))) throw Object.assign(new Error("نوع الحركة غير صالح"), { status: 400 });
    conditions.push(`t.type IN (${requestedTypes.map(() => "?").join(",")})`);
    values.push(...requestedTypes);
  }
  const pharmacyId = search.get("pharmacyId");
  if (pharmacyId) {
    if (!/^\d+$/.test(pharmacyId)) throw Object.assign(new Error("رقم الصيدلية غير صالح"), { status: 400 });
    conditions.push("t.pharmacy_id = ?");
    values.push(Number(pharmacyId));
  }
  const paymentMethod = search.get("paymentMethod");
  if (paymentMethod) {
    if (!paymentMethodSet.has(paymentMethod)) throw Object.assign(new Error("طريقة الدفع غير صالحة"), { status: 400 });
    conditions.push(`(t.payment_method = ? OR EXISTS (
      SELECT 1 FROM transaction_payment_splits split
      WHERE split.transaction_id=t.id AND split.payment_method=?
    ))`);
    values.push(paymentMethod);
    values.push(paymentMethod);
  }
  for (const [key, operator] of [["from", ">="], ["to", "<="]]) {
    const date = search.get(key);
    if (date) {
      if (!validDate(date)) throw Object.assign(new Error("التاريخ غير صالح"), { status: 400 });
      conditions.push(`t.date ${operator} ?`);
      values.push(date);
    }
  }
  const records = db.prepare(`
    SELECT t.id, t.pharmacy_id AS pharmacyId, p.name AS pharmacyName, t.type, t.amount,
      t.date, t.description, t.payment_method AS paymentMethod,
      t.shift_id AS shiftId, s.start_time AS shiftStartTime,s.end_time AS shiftEndTime,
      t.shift_template_id AS shiftTemplateId,pt.name AS shiftTemplateName,
      pt.start_time AS shiftTemplateStartTime,pt.end_time AS shiftTemplateEndTime,
      u.display_name AS shiftUserName,t.created_at AS createdAt
    FROM transactions t
    JOIN pharmacies p ON p.id = t.pharmacy_id
    LEFT JOIN shifts s ON s.id=t.shift_id
    LEFT JOIN pharmacy_shift_templates pt ON pt.id=t.shift_template_id
    LEFT JOIN users u ON u.id=s.user_id
    ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
    ORDER BY t.date DESC, t.id DESC LIMIT 500
  `).all(...values);
  if (!records.length) return records;
  const splitRows = db.prepare(`
    SELECT transaction_id AS transactionId,payment_method AS paymentMethod,amount
    FROM transaction_payment_splits
    WHERE transaction_id IN (${records.map(() => "?").join(",")})
  `).all(...records.map((record) => record.id));
  const splitsByTransaction = new Map(records.map((record) => [record.id, {}]));
  for (const split of splitRows) splitsByTransaction.get(split.transactionId)[split.paymentMethod] = split.amount;
  return records.map((record) => ({ ...record, paymentSplits: splitsByTransaction.get(record.id) }));
}

function validateShift(body, excludeShiftId = 0) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw Object.assign(new Error("بيانات الوردية غير صالحة"), { status: 400 });
  }
  const pharmacyId = Number(body.pharmacyId);
  const userId = Number(body.userId);
  const date = body.date;
  const startTime = body.startTime;
  const endTime = body.endTime;
  const notes = typeof body.notes === "string" ? body.notes.trim() : "";
  if (!Number.isSafeInteger(pharmacyId) || pharmacyId < 1) throw Object.assign(new Error("اختر فرعاً صحيحاً"), { status: 400 });
  if (!Number.isSafeInteger(userId) || userId < 1) throw Object.assign(new Error("اختر مستخدماً للوردية"), { status: 400 });
  if (!validDate(date)) throw Object.assign(new Error("أدخل تاريخاً صحيحاً للوردية"), { status: 400 });
  const validTime = (value) => typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
  if (!validTime(startTime) || !validTime(endTime) || startTime >= endTime) {
    throw Object.assign(new Error("يجب أن يكون وقت النهاية بعد وقت البداية في اليوم نفسه"), { status: 400 });
  }
  if (notes.length > 300) throw Object.assign(new Error("ملاحظات الوردية أطول من الحد المسموح"), { status: 400 });
  if (!db.prepare("SELECT 1 FROM pharmacies WHERE id=?").get(pharmacyId)) {
    throw Object.assign(new Error("الفرع المحدد غير موجود"), { status: 400 });
  }
  if (!db.prepare("SELECT 1 FROM users WHERE id=? AND role IN ('user','branch_manager') AND pharmacy_id=?").get(userId, pharmacyId)) {
    throw Object.assign(new Error("يجب اختيار مستخدم مرتبط بالفرع المحدد"), { status: 400 });
  }
  if (db.prepare(`
    SELECT 1 FROM shifts
    WHERE user_id=? AND shift_date=? AND start_time < ? AND end_time > ? AND id != ?
    LIMIT 1
  `).get(userId, date, endTime, startTime, excludeShiftId)) {
    throw Object.assign(new Error("لدى المستخدم وردية أخرى تتداخل مع هذا الوقت"), { status: 409 });
  }
  return { pharmacyId, userId, date, startTime, endTime, notes };
}

function validatePharmacyShiftTemplates(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 12) {
    throw Object.assign(new Error("أضف من وردية واحدة إلى 12 وردية للفرع"), { status: 400 });
  }
  const validTime = (time) => typeof time === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time);
  const names = new Set();
  const templates = value.map((item) => {
    const name = typeof item?.name === "string" ? item.name.trim() : "";
    const startTime = item?.startTime;
    const endTime = item?.endTime;
    if (!name || name.length > 60) {
      throw Object.assign(new Error("أدخل اسماً لكل وردية بحد أقصى 60 حرفاً"), { status: 400 });
    }
    if (!validTime(startTime) || !validTime(endTime) || startTime >= endTime) {
      throw Object.assign(new Error("يجب أن يكون وقت نهاية كل وردية بعد بدايتها في اليوم نفسه"), { status: 400 });
    }
    const normalizedName = name.toLocaleLowerCase();
    if (names.has(normalizedName)) {
      throw Object.assign(new Error("يجب أن تكون أسماء الشيفتات مختلفة"), { status: 400 });
    }
    names.add(normalizedName);
    return { name, startTime, endTime };
  }).sort((left, right) => left.startTime.localeCompare(right.startTime));
  for (let index = 1; index < templates.length; index += 1) {
    if (templates[index].startTime < templates[index - 1].endTime) {
      throw Object.assign(new Error("لا يمكن أن تتداخل أوقات ورديات الفرع"), { status: 400 });
    }
  }
  return templates;
}

function shiftsList(user, pharmacyId = "", date = "") {
  const conditions = [];
  const values = [];
  if (user.role !== "admin") {
    conditions.push("s.pharmacy_id = ?");
    values.push(user.pharmacy_id || 0);
    if (!hasPermission(user, "manage_shifts")) {
      conditions.push("s.user_id = ?");
      values.push(user.id);
    }
  }
  if (pharmacyId) {
    conditions.push("s.pharmacy_id = ?");
    values.push(pharmacyId);
  }
  if (date) {
    conditions.push("s.shift_date = ?");
    values.push(date);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  return db.prepare(`
    SELECT s.id,s.pharmacy_id AS pharmacyId,p.name AS pharmacyName,s.user_id AS userId,
      u.display_name AS userName,s.shift_date AS date,s.start_time AS startTime,
      s.end_time AS endTime,s.notes,s.sales_amount AS salesAmount,
      s.closed_at AS closedAt,s.created_at AS createdAt
    FROM shifts s
    JOIN pharmacies p ON p.id=s.pharmacy_id
    LEFT JOIN users u ON u.id=s.user_id
    ${where}
    ORDER BY s.shift_date DESC,s.start_time,s.id DESC LIMIT 500
  `).all(...values);
}

function shiftAnalyticsData(user) {
  const period = db.prepare(`
    SELECT strftime('%Y-%m','now','localtime') AS currentMonth,
      strftime('%Y-%m','now','localtime','start of month','-1 month') AS previousMonth,
      date('now','localtime','start of month') AS currentStart,
      date('now','localtime','start of month','-1 month') AS previousStart,
      date('now','localtime','start of month','+1 month') AS nextStart,
      CAST(strftime('%d','now','localtime') AS INTEGER) AS currentMonthDays,
      CAST(strftime('%d',date('now','localtime','start of month','-1 day')) AS INTEGER) AS previousMonthDays
  `).get();
  const branchCondition = user.branch_restricted ? "AND p.id=?" : "";
  const rows = db.prepare(`
    SELECT pt.id,pt.pharmacy_id AS pharmacyId,p.name AS pharmacyName,pt.name,
      pt.start_time AS startTime,pt.end_time AS endTime,
      COALESCE(SUM(CASE WHEN t.date>=? AND t.date<? THEN t.amount ELSE 0 END),0) AS currentSales,
      COALESCE(SUM(CASE WHEN t.date>=? AND t.date<? THEN t.amount ELSE 0 END),0) AS previousSales
    FROM pharmacy_shift_templates pt
    JOIN pharmacies p ON p.id=pt.pharmacy_id
    LEFT JOIN transactions t ON t.type='sale'
      AND t.date>=? AND t.date<?
      AND (
        t.shift_template_id=pt.id
        OR (
          t.shift_template_id IS NULL
          AND EXISTS (
            SELECT 1 FROM shifts s
            WHERE s.id=t.shift_id AND s.pharmacy_id=pt.pharmacy_id
              AND s.start_time=pt.start_time AND s.end_time=pt.end_time
          )
        )
      )
    WHERE 1=1 ${branchCondition}
    GROUP BY pt.id
    ORDER BY p.name COLLATE NOCASE,pt.start_time,pt.id
  `).all(
    period.currentStart, period.nextStart,
    period.previousStart, period.currentStart,
    period.previousStart, period.nextStart,
    ...(user.branch_restricted ? [user.pharmacy_id || 0] : []),
  );
  return {
    currentMonth: period.currentMonth,
    previousMonth: period.previousMonth,
    currentMonthDays: period.currentMonthDays,
    previousMonthDays: period.previousMonthDays,
    shifts: rows.map((shift) => ({
      ...shift,
      currentAverage: shift.currentSales / period.currentMonthDays,
      previousAverage: shift.previousSales / period.previousMonthDays,
    })),
  };
}

async function handleApi(request, response, url) {
  const { pathname, searchParams } = url;
  const method = request.method;
  if (pathname === "/api/health" && request.method === "GET") {
    return json(response, 200, { status: "ok", database: "sqlite" });
  }
  if (pathname.startsWith("/api/") && method !== "GET" && method !== "HEAD") assertSameOrigin(request);
  if (pathname === "/api/auth/status" && method === "GET") {
    const user = requestUser(request);
    const userCount = db.prepare("SELECT COUNT(*) AS count FROM users").get().count;
    return json(response, 200, { setupRequired: userCount === 0, user: user ? publicUser(user) : null });
  }
  if (pathname === "/api/auth/setup" && method === "POST") {
    allowAttempt(request, "setup", 5);
    const account = validateAccount(await readJson(request), { creatingAdmin: true });
    const passwordHash = await hashPassword(account.password);
    db.exec("BEGIN IMMEDIATE");
    let result;
    try {
      const userCount = db.prepare("SELECT COUNT(*) AS count FROM users").get().count;
      if (userCount !== 0) throw Object.assign(new Error("تم إعداد المدير بالفعل. سجّل الدخول للمتابعة."), { status: 409 });
      result = db.prepare("INSERT INTO users(username,display_name,password_hash,role) VALUES(?,?,?,'admin')")
        .run(account.username, account.displayName, passwordHash);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      if (String(error.message).includes("UNIQUE")) throw Object.assign(new Error("اسم المستخدم مسجل بالفعل"), { status: 409 });
      throw error;
    }
    const userId = Number(result.lastInsertRowid);
    createSession(request, response, userId);
    const user = db.prepare("SELECT id,username,display_name,role FROM users WHERE id=?").get(userId);
    return json(response, 201, { user: publicUser(user) });
  }
  if (pathname === "/api/auth/login" && method === "POST") {
    allowAttempt(request, "login", 10);
    const body = await readJson(request);
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (username.length > 40 || password.length > 128) throw Object.assign(new Error("بيانات تسجيل الدخول غير صحيحة"), { status: 401 });
    const user = db.prepare("SELECT id,username,display_name,password_hash,role,pharmacy_id,permissions FROM users WHERE username=? COLLATE NOCASE").get(username);
    const valid = user ? await verifyPassword(password, user.password_hash) : false;
    if (!valid) throw Object.assign(new Error("اسم المستخدم أو كلمة المرور غير صحيحة"), { status: 401 });
    loginAttempts.delete(`login:${request.socket.remoteAddress || "unknown"}`);
    createSession(request, response, user.id);
    return json(response, 200, { user: publicUser(user) });
  }
  if (pathname === "/api/auth/logout" && method === "POST") {
    const token = readSessionToken(request);
    if (token) db.prepare("DELETE FROM sessions WHERE token_hash=?").run(crypto.createHash("sha256").update(token).digest("hex"));
    clearSessionCookie(request, response);
    return json(response, 200, { loggedOut: true });
  }

  const user = requestUser(request);
  if (!user) return json(response, 401, { error: "يلزم تسجيل الدخول للمتابعة" });
  const isAdmin = user.role === "admin";
  const requireAdmin = () => {
    if (!isAdmin) throw Object.assign(new Error("تتطلب هذه العملية صلاحية المدير"), { status: 403 });
  };
  const requirePermission = (permission) => {
    if (!hasPermission(user, permission)) {
      throw Object.assign(new Error("لا تملك الصلاحية اللازمة لتنفيذ هذه العملية"), { status: 403 });
    }
  };
  const requireBranchAccess = (pharmacyId) => {
    if (!isAdmin && (!user.pharmacy_id || Number(pharmacyId) !== user.pharmacy_id)) {
      throw Object.assign(new Error("يمكنك إدارة بيانات فرعك المخصص فقط"), { status: 403 });
    }
  };

  if (pathname === "/api/users" && method === "GET") {
    requireAdmin();
    const accounts = db.prepare(`
      SELECT u.id,u.username,u.display_name AS displayName,u.role,u.pharmacy_id AS pharmacyId,
        p.name AS pharmacyName,u.created_at AS createdAt,u.permissions
      FROM users u LEFT JOIN pharmacies p ON p.id=u.pharmacy_id
      ORDER BY u.created_at DESC,u.id DESC
    `).all();
    return json(response, 200, accounts.map((account) => ({
      ...account,
      permissions: account.role === "admin" ? [...permissionSet] : JSON.parse(account.permissions),
    })));
  }
  if (pathname === "/api/branch-users" && method === "GET") {
    requirePermission("manage_shifts");
    const branchUsers = db.prepare(`
      SELECT id,username,display_name AS displayName,role,pharmacy_id AS pharmacyId
      FROM users
      WHERE pharmacy_id=? AND role IN ('user','branch_manager')
      ORDER BY display_name COLLATE NOCASE,id
    `).all(user.pharmacy_id);
    return json(response, 200, branchUsers);
  }
  if (pathname === "/api/users" && method === "POST") {
    requireAdmin();
    const account = validateAccount(await readJson(request));
    if (account.pharmacyId && !db.prepare("SELECT 1 FROM pharmacies WHERE id=?").get(account.pharmacyId)) {
      throw Object.assign(new Error("الصيدلية المحددة غير موجودة"), { status: 400 });
    }
    const passwordHash = await hashPassword(account.password);
    try {
      const result = db.prepare("INSERT INTO users(username,display_name,password_hash,role,pharmacy_id,branch_restricted,permissions) VALUES(?,?,?,?,?,?,?)")
        .run(
          account.username,
          account.displayName,
          passwordHash,
          account.role,
          account.pharmacyId,
          account.role === "admin" ? 0 : 1,
          JSON.stringify(account.permissions),
        );
      const created = db.prepare(`
        SELECT u.id,u.username,u.display_name AS displayName,u.role,u.pharmacy_id AS pharmacyId,
          p.name AS pharmacyName,u.created_at AS createdAt,u.permissions
        FROM users u LEFT JOIN pharmacies p ON p.id=u.pharmacy_id WHERE u.id=?
      `).get(Number(result.lastInsertRowid));
      return json(response, 201, {
        ...created,
        permissions: created.role === "admin" ? [...permissionSet] : JSON.parse(created.permissions),
      });
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) throw Object.assign(new Error("اسم المستخدم مسجل بالفعل"), { status: 409 });
      throw error;
    }
  }
  const userMatch = pathname.match(/^\/api\/users\/(\d+)$/);
  if (userMatch && method === "PUT") {
    requireAdmin();
    const targetId = Number(userMatch[1]);
    const existing = db.prepare("SELECT id,role FROM users WHERE id=?").get(targetId);
    if (!existing) return json(response, 404, { error: "المستخدم غير موجود" });
    const account = validateAccount(await readJson(request), { passwordOptional: true });
    if (account.pharmacyId && !db.prepare("SELECT 1 FROM pharmacies WHERE id=?").get(account.pharmacyId)) {
      throw Object.assign(new Error("الصيدلية المحددة غير موجودة"), { status: 400 });
    }
    if (
      existing.role === "admin"
      && account.role !== "admin"
      && db.prepare("SELECT COUNT(*) AS count FROM users WHERE role='admin'").get().count <= 1
    ) {
      throw Object.assign(new Error("لا يمكن تغيير صلاحية آخر حساب مدير"), { status: 409 });
    }
    const passwordHash = account.password ? await hashPassword(account.password) : null;
    try {
      db.prepare(`
        UPDATE users
        SET username=?,display_name=?,role=?,pharmacy_id=?,branch_restricted=?,permissions=?,
          password_hash=COALESCE(?,password_hash)
        WHERE id=?
      `).run(
        account.username,
        account.displayName,
        account.role,
        account.pharmacyId,
        account.role === "admin" ? 0 : 1,
        JSON.stringify(account.permissions),
        passwordHash,
        targetId,
      );
      const updated = db.prepare(`
        SELECT u.id,u.username,u.display_name AS displayName,u.role,u.pharmacy_id AS pharmacyId,
          p.name AS pharmacyName,u.created_at AS createdAt,u.permissions
        FROM users u LEFT JOIN pharmacies p ON p.id=u.pharmacy_id WHERE u.id=?
      `).get(targetId);
      return json(response, 200, {
        ...updated,
        permissions: updated.role === "admin" ? [...permissionSet] : JSON.parse(updated.permissions),
      });
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) throw Object.assign(new Error("اسم المستخدم مسجل بالفعل"), { status: 409 });
      throw error;
    }
  }
  if (userMatch && method === "DELETE") {
    requireAdmin();
    const targetId = Number(userMatch[1]);
    if (targetId === user.id) throw Object.assign(new Error("لا يمكنك حذف حسابك أثناء تسجيل الدخول"), { status: 400 });
    const target = db.prepare("SELECT id,role FROM users WHERE id=?").get(targetId);
    if (!target) return json(response, 404, { error: "المستخدم غير موجود" });
    if (target.role === "admin" && db.prepare("SELECT COUNT(*) AS count FROM users WHERE role='admin'").get().count <= 1) {
      throw Object.assign(new Error("لا يمكن حذف آخر حساب مدير"), { status: 409 });
    }
    db.prepare("DELETE FROM users WHERE id=?").run(targetId);
    return json(response, 200, { deleted: true });
  }
  if (pathname === "/api/dashboard" && request.method === "GET") {
    requirePermission("view_data");
    return json(response, 200, dashboardData(user));
  }
  if (pathname === "/api/shift-analytics" && method === "GET") {
    requirePermission("view_data");
    return json(response, 200, shiftAnalyticsData(user));
  }
  if (pathname === "/api/pharmacies" && request.method === "GET") {
    requirePermission("view_data");
    return json(response, 200, pharmacyList(user));
  }
  if (pathname === "/api/pharmacies" && request.method === "POST") {
    requireAdmin();
    const body = await readJson(request);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const location = typeof body.location === "string" ? body.location.trim() : "";
    if (!name || name.length > 120 || location.length > 200) throw Object.assign(new Error("أدخل اسم صيدلية صحيحاً وعنواناً لا يتجاوز 200 حرف"), { status: 400 });
    const shiftTemplates = validatePharmacyShiftTemplates(body.shiftTemplates);
    try {
      db.exec("BEGIN IMMEDIATE");
      const result = db.prepare("INSERT INTO pharmacies(name, location) VALUES(?, ?)").run(name, location);
      const pharmacyId = Number(result.lastInsertRowid);
      const insertTemplate = db.prepare(`
        INSERT INTO pharmacy_shift_templates(pharmacy_id,name,start_time,end_time) VALUES(?,?,?,?)
      `);
      for (const template of shiftTemplates) {
        insertTemplate.run(pharmacyId, template.name, template.startTime, template.endTime);
      }
      db.exec("COMMIT");
      return json(response, 201, { id: pharmacyId, name, location, shifts: shiftTemplates });
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      if (String(error.message).includes("UNIQUE")) throw Object.assign(new Error("اسم الصيدلية مسجل بالفعل"), { status: 409 });
      throw error;
    }
  }
  const pharmacyMatch = pathname.match(/^\/api\/pharmacies\/(\d+)$/);
  if (pharmacyMatch && request.method === "DELETE") {
    requireAdmin();
    const result = db.prepare("DELETE FROM pharmacies WHERE id = ?").run(Number(pharmacyMatch[1]));
    if (!result.changes) return json(response, 404, { error: "الصيدلية غير موجودة" });
    return json(response, 200, { deleted: true });
  }
  if (pathname === "/api/transactions" && request.method === "GET") {
    requirePermission("view_data");
    return json(response, 200, transactionsList(searchParams, user));
  }
  if (pathname === "/api/shifts" && method === "GET") {
    requirePermission("view_data");
    const pharmacyId = searchParams.get("pharmacyId") || "";
    const date = searchParams.get("date") || "";
    if (pharmacyId && !/^\d+$/.test(pharmacyId)) {
      throw Object.assign(new Error("رقم الصيدلية غير صالح"), { status: 400 });
    }
    if (date && !validDate(date)) throw Object.assign(new Error("التاريخ غير صالح"), { status: 400 });
    return json(response, 200, shiftsList(user, pharmacyId ? Number(pharmacyId) : "", date));
  }
  if (pathname === "/api/shifts" && method === "POST") {
    requirePermission("manage_shifts");
    const shift = validateShift(await readJson(request));
    requireBranchAccess(shift.pharmacyId);
    const result = db.prepare(`
      INSERT INTO shifts(pharmacy_id,user_id,shift_date,start_time,end_time,notes)
      VALUES(?,?,?,?,?,?)
    `).run(shift.pharmacyId, shift.userId, shift.date, shift.startTime, shift.endTime, shift.notes);
    return json(response, 201, { id: Number(result.lastInsertRowid) });
  }
  const shiftMatch = pathname.match(/^\/api\/shifts\/(\d+)$/);
  const closeShiftMatch = pathname.match(/^\/api\/shifts\/(\d+)\/close$/);
  if (closeShiftMatch && method === "POST") {
    const shiftId = Number(closeShiftMatch[1]);
    const shift = db.prepare("SELECT id,pharmacy_id AS pharmacyId,user_id AS userId,sales_amount AS salesAmount FROM shifts WHERE id=?").get(shiftId);
    if (!shift) return json(response, 404, { error: "الوردية غير موجودة" });
    if (!isAdmin) requireBranchAccess(shift.pharmacyId);
    const canManageBranchShifts = hasPermission(user, "manage_shifts");
    if (!isAdmin && !canManageBranchShifts && (
      !hasPermission(user, "close_shifts") || !user.pharmacy_id || shift.userId !== user.id
    )) {
      throw Object.assign(new Error("يمكنك إغلاق الشيفتات المخصصة لحسابك فقط"), { status: 403 });
    }
    if (!isAdmin && !canManageBranchShifts && shift.salesAmount !== null) {
      throw Object.assign(new Error("تم إغلاق هذه الوردية بالفعل"), { status: 409 });
    }
    const body = await readJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw Object.assign(new Error("بيانات إغلاق الوردية غير صالحة"), { status: 400 });
    }
    const salesAmount = Number(body.salesAmount);
    if (!Number.isFinite(salesAmount) || salesAmount < 0 || salesAmount > 1_000_000_000_000) {
      throw Object.assign(new Error("أدخل إجمالي مبيعات صحيحاً لا يقل عن صفر"), { status: 400 });
    }
    const result = isAdmin || canManageBranchShifts
      ? db.prepare("UPDATE shifts SET sales_amount=?,closed_at=datetime('now','localtime') WHERE id=?").run(salesAmount, shiftId)
      : db.prepare("UPDATE shifts SET sales_amount=?,closed_at=datetime('now','localtime') WHERE id=? AND sales_amount IS NULL").run(salesAmount, shiftId);
    if (!result.changes) {
      throw Object.assign(new Error("تم إغلاق هذه الوردية بالفعل"), { status: 409 });
    }
    return json(response, 200, { closed: true, salesAmount });
  }
  if (shiftMatch && method === "PUT") {
    requirePermission("manage_shifts");
    const shiftId = Number(shiftMatch[1]);
    const existingShift = db.prepare("SELECT pharmacy_id AS pharmacyId,user_id AS userId,shift_date AS date FROM shifts WHERE id=?").get(shiftId);
    if (!existingShift) {
      return json(response, 404, { error: "الوردية غير موجودة" });
    }
    requireBranchAccess(existingShift.pharmacyId);
    const shift = validateShift(await readJson(request), shiftId);
    requireBranchAccess(shift.pharmacyId);
    const hasSales = db.prepare("SELECT 1 FROM transactions WHERE shift_id=? LIMIT 1").get(shiftId);
    if (hasSales && (
      existingShift.pharmacyId !== shift.pharmacyId
      || existingShift.userId !== shift.userId
      || existingShift.date !== shift.date
    )) {
      throw Object.assign(new Error("لا يمكن تغيير الفرع أو المستخدم أو التاريخ لوردية مرتبطة بمبيعات"), { status: 409 });
    }
    db.prepare(`
      UPDATE shifts
      SET pharmacy_id=?,user_id=?,shift_date=?,start_time=?,end_time=?,notes=?
      WHERE id=?
    `).run(shift.pharmacyId, shift.userId, shift.date, shift.startTime, shift.endTime, shift.notes, shiftId);
    return json(response, 200, { updated: true });
  }
  if (shiftMatch && method === "DELETE") {
    requirePermission("manage_shifts");
    const shiftId = Number(shiftMatch[1]);
    const shift = db.prepare("SELECT pharmacy_id AS pharmacyId FROM shifts WHERE id=?").get(shiftId);
    if (!shift) return json(response, 404, { error: "الوردية غير موجودة" });
    requireBranchAccess(shift.pharmacyId);
    if (db.prepare("SELECT 1 FROM transactions WHERE shift_id=? LIMIT 1").get(shiftId)) {
      throw Object.assign(new Error("لا يمكن حذف وردية مرتبطة بمبيعات مسجلة"), { status: 409 });
    }
    const result = db.prepare("DELETE FROM shifts WHERE id=?").run(shiftId);
    if (!result.changes) return json(response, 404, { error: "الوردية غير موجودة" });
    return json(response, 200, { deleted: true });
  }
  const transactionPostMatch = pathname.match(/^\/api\/transactions(?:\/(sale|purchase|expense|income|supply|adjustment))?$/);
  if (transactionPostMatch && request.method === "POST") {
    requirePermission("record_transactions");
    const body = await readJson(request);
    const type = transactionPostMatch[1] || body.type;
    if (transactionPostMatch[1] && body.type && body.type !== transactionPostMatch[1]) {
      throw Object.assign(new Error("نوع الحركة لا يطابق صفحة التسجيل"), { status: 400 });
    }
    const pharmacyId = Number(body.pharmacyId);
    requireBranchAccess(pharmacyId);
    const amount = Number(body.amount);
    const date = body.date;
    const description = typeof body.description === "string" ? body.description.trim() : "";
    const paymentMethod = body.paymentMethod || "cash";
    if (!Number.isSafeInteger(pharmacyId) || pharmacyId < 1) throw Object.assign(new Error("اختر صيدلية صحيحة"), { status: 400 });
    if (!transactionTypeSet.has(type)) throw Object.assign(new Error("نوع الحركة غير صالح"), { status: 400 });
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000_000) throw Object.assign(new Error("يجب أن يكون المبلغ أكبر من صفر"), { status: 400 });
    if (!validDate(date)) throw Object.assign(new Error("أدخل تاريخاً صحيحاً"), { status: 400 });
    if (description.length > 300) throw Object.assign(new Error("الوصف أطول من الحد المسموح"), { status: 400 });
    if (!paymentMethodSet.has(paymentMethod)) throw Object.assign(new Error("طريقة الدفع غير صالحة"), { status: 400 });
    if (type === "supply" && !supplyPaymentMethodSet.has(paymentMethod)) {
      throw Object.assign(new Error("يجب أن يكون مصدر التوريد فيزا أو إنستاباي أو فودافون"), { status: 400 });
    }
    let paymentSplits = null;
    if (type === "sale" && body.paymentSplits !== undefined) {
      if (!body.paymentSplits || typeof body.paymentSplits !== "object" || Array.isArray(body.paymentSplits)) {
        throw Object.assign(new Error("توزيع مبالغ البيع حسب طرق الدفع غير صالح"), { status: 400 });
      }
      paymentSplits = [];
      let splitTotal = 0;
      for (const [method, rawAmount] of Object.entries(body.paymentSplits)) {
        if (!salePaymentMethodSet.has(method)) {
          throw Object.assign(new Error("طريقة دفع غير صالحة ضمن توزيع البيع"), { status: 400 });
        }
        const splitAmount = Number(rawAmount);
        if (!Number.isFinite(splitAmount) || splitAmount < 0 || splitAmount > 1_000_000_000_000) {
          throw Object.assign(new Error("أدخل مبلغاً صحيحاً لكل طريقة دفع"), { status: 400 });
        }
        const cents = Math.round(splitAmount * 100);
        splitTotal += cents;
        if (cents > 0) paymentSplits.push({ method, amount: cents / 100 });
      }
      if (!paymentSplits.length || splitTotal !== Math.round(amount * 100)) {
        throw Object.assign(new Error("يجب أن يساوي مجموع مبالغ طرق الدفع إجمالي مبلغ البيع"), { status: 400 });
      }
    } else if (type !== "sale" && body.paymentSplits !== undefined) {
      throw Object.assign(new Error("توزيع طرق الدفع متاح للمبيعات فقط"), { status: 400 });
    }
    if (!db.prepare("SELECT 1 FROM pharmacies WHERE id = ?").get(pharmacyId)) {
      throw Object.assign(new Error("الصيدلية غير موجودة"), { status: 404 });
    }
    let shiftId = body.shiftId === undefined || body.shiftId === "" ? null : Number(body.shiftId);
    const shiftTemplateId = body.shiftTemplateId === undefined || body.shiftTemplateId === "" ? null : Number(body.shiftTemplateId);
    if (type === "sale") {
      if (shiftTemplateId !== null) {
        if (!Number.isSafeInteger(shiftTemplateId) || shiftTemplateId < 1
          || !db.prepare("SELECT 1 FROM pharmacy_shift_templates WHERE id=? AND pharmacy_id=?").get(shiftTemplateId, pharmacyId)) {
          throw Object.assign(new Error("اختر وردية معرفة للفرع المحدد"), { status: 400 });
        }
        shiftId = null;
      } else {
        if (shiftId === null) {
          throw Object.assign(new Error("لم يصل اختيار الوردية. اختر وردية الفرع ثم أعد تسجيل البيع."), { status: 400 });
        }
        if (!Number.isSafeInteger(shiftId) || shiftId < 1) {
          throw Object.assign(new Error("اختر وردية صحيحة"), { status: 400 });
        }
        const shift = db.prepare(`
          SELECT id,pharmacy_id AS pharmacyId,user_id AS userId,shift_date AS date,sales_amount AS salesAmount
          FROM shifts WHERE id=?
        `).get(shiftId);
        if (!shift || shift.pharmacyId !== pharmacyId || shift.date !== date) {
          throw Object.assign(new Error("الوردية المحددة لا تطابق الفرع وتاريخ عملية البيع"), { status: 400 });
        }
        if (shift.salesAmount !== null) {
          throw Object.assign(new Error("لا يمكن تسجيل عملية بيع على وردية مغلقة"), { status: 409 });
        }
        if (!isAdmin && !hasPermission(user, "manage_shifts") && shift.userId !== user.id) {
          throw Object.assign(new Error("يمكنك تسجيل المبيعات على الشيفتات المخصصة لحسابك فقط"), { status: 403 });
        }
        if (!isAdmin) requireBranchAccess(shift.pharmacyId);
      }
    } else if (shiftId !== null || shiftTemplateId !== null) {
      throw Object.assign(new Error("يمكن ربط الوردية بعمليات البيع فقط"), { status: 400 });
    }
    if (type === "sale" && paymentSplits) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = db.prepare(`
          INSERT INTO transactions(pharmacy_id,type,amount,date,description,payment_method,shift_id,shift_template_id)
          VALUES(?,?,?,?,?,?,?,?)
        `).run(pharmacyId, type, amount, date, description, paymentMethod, shiftId, shiftTemplateId);
        const insertSplit = db.prepare(`
          INSERT INTO transaction_payment_splits(transaction_id,payment_method,amount)
          VALUES(?,?,?)
        `);
        for (const split of paymentSplits) {
          insertSplit.run(Number(result.lastInsertRowid), split.method, split.amount);
        }
        db.exec("COMMIT");
        return json(response, 201, { id: Number(result.lastInsertRowid) });
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    }
    if (["purchase", "expense", "supply"].includes(type)) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const balance = db.prepare(`
          SELECT COALESCE(SUM(amount),0) AS balance FROM (
            SELECT CASE
                WHEN t.type='supply' AND t.payment_method!='cash' THEN -t.amount
                WHEN t.type IN ('sale','income','supply') THEN t.amount
                WHEN t.type IN ('purchase','expense') THEN -t.amount
                ELSE 0
              END AS amount
            FROM transactions t
            WHERE t.pharmacy_id=? AND t.payment_method=?
              AND (t.type!='sale' OR NOT EXISTS (
                SELECT 1 FROM transaction_payment_splits split WHERE split.transaction_id=t.id
              ))
            UNION ALL
            SELECT split.amount
            FROM transaction_payment_splits split
            JOIN transactions t ON t.id=split.transaction_id
            WHERE t.pharmacy_id=? AND split.payment_method=?
          )
        `).get(pharmacyId, paymentMethod, pharmacyId, paymentMethod).balance;
        let availableBalance = balance;
        if (paymentMethod === "cash") {
          const suppliedCash = db.prepare(`
            SELECT COALESCE(SUM(amount),0) AS balance
            FROM transactions
            WHERE pharmacy_id=? AND type='supply' AND payment_method!='cash'
          `).get(pharmacyId).balance;
          availableBalance += suppliedCash;
        }
        if (Math.round(amount * 100) > Math.round(availableBalance * 100)) {
          throw Object.assign(new Error("رصيد طريقة الدفع المختارة أقل من مبلغ الحركة"), { status: 409 });
        }
        const result = db.prepare(`
          INSERT INTO transactions(pharmacy_id,type,amount,date,description,payment_method,shift_id,shift_template_id)
          VALUES(?,?,?,?,?,?,?,?)
        `).run(pharmacyId, type, amount, date, description, paymentMethod, shiftId, shiftTemplateId);
        db.exec("COMMIT");
        return json(response, 201, { id: Number(result.lastInsertRowid) });
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    }
    const result = db.prepare(`
      INSERT INTO transactions(pharmacy_id,type,amount,date,description,payment_method,shift_id,shift_template_id)
      VALUES(?,?,?,?,?,?,?,?)
    `).run(pharmacyId, type, amount, date, description, paymentMethod, shiftId, shiftTemplateId);
    return json(response, 201, { id: Number(result.lastInsertRowid) });
  }
  const transactionMatch = pathname.match(/^\/api\/transactions\/(\d+)$/);
  if (transactionMatch && request.method === "DELETE") {
    requirePermission("delete_transactions");
    const transaction = db.prepare("SELECT pharmacy_id AS pharmacyId FROM transactions WHERE id=?").get(Number(transactionMatch[1]));
    if (!transaction) return json(response, 404, { error: "الحركة غير موجودة" });
    requireBranchAccess(transaction.pharmacyId);
    const result = db.prepare("DELETE FROM transactions WHERE id = ?").run(Number(transactionMatch[1]));
    if (!result.changes) return json(response, 404, { error: "الحركة غير موجودة" });
    return json(response, 200, { deleted: true });
  }
  return json(response, 404, { error: "المسار غير موجود" });
}

function serveStatic(request, response, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return json(response, 400, { error: "مسار غير صالح" });
  }
  const relativePath = decoded === "/" ? "index.html" : decoded.replace(/^[/\\]+/, "");
  if (!publicFiles.has(relativePath)) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return response.end("Not found");
  }
  const filePath = path.resolve(root, relativePath);
  if (!filePath.startsWith(`${root}${path.sep}`)) return json(response, 403, { error: "الوصول مرفوض" });
  fs.readFile(filePath, (error, data) => {
    if (error) {
      response.writeHead(error.code === "ENOENT" ? 404 : 500, { "Content-Type": "text/plain; charset=utf-8" });
      return response.end(error.code === "ENOENT" ? "Not found" : "Unable to read file");
    }
    response.writeHead(200, { "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream", "Cache-Control": "no-cache" });
    response.end(data);
  });
}

const server = http.createServer(async (request, response) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      json(response, 405, { error: "الطريقة غير مسموحة" });
      return;
    }
    serveStatic(request, response, url.pathname);
  } catch (error) {
    json(response, error.status || 500, { error: error.status ? error.message : "حدث خطأ داخلي في الخادم" });
    if (!error.status) console.error(error);
  }
});

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
server.listen(port, host, () => console.log(`Pharmacy app available at http://localhost:${port} (network interface: ${host})`));

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
