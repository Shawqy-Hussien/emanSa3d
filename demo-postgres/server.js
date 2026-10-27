"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const { closePool, getPool, migrate } = require("./db");

const root = path.resolve(__dirname, "..");
const publicFiles = new Set(["index.html", "styles.css", "app.js"]);
const sessionCookie = "pharmacy_session";
const sessionLifetime = 12 * 60 * 60 * 1000;
const loginAttempts = new Map();
const scrypt = promisify(crypto.scrypt);
const transactionTypeSet = new Set(["sale", "purchase", "expense", "income", "supply", "adjustment"]);
const paymentMethodSet = new Set(["cash", "bank", "credit"]);
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function fail(message, status) {
  return Object.assign(new Error(message), { status });
}

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

function publicUser(user) {
  return { id: user.id, username: user.username, displayName: user.display_name, role: user.role };
}

function readSessionToken(request) {
  for (const cookie of (request.headers.cookie || "").split(";")) {
    const separator = cookie.indexOf("=");
    if (separator !== -1 && cookie.slice(0, separator).trim() === sessionCookie) {
      return cookie.slice(separator + 1).trim();
    }
  }
  return "";
}

async function requestUser(request, database) {
  const token = readSessionToken(request);
  if (!token || !/^[\w-]{40,60}$/.test(token)) return null;
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const result = await database.query(`
    SELECT u.id, u.username, u.display_name, u.role, s.expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = $1
  `, [tokenHash]);
  const session = result.rows[0];
  if (!session || Number(session.expires_at) <= Date.now()) {
    await database.query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash]);
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

function validateAccount(body, { creatingAdmin = false } = {}) {
  const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
  const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!/^[a-z0-9_.-]{3,40}$/.test(username)) throw fail("اسم المستخدم غير صالح", 400);
  if (!displayName || displayName.length > 100) throw fail("الاسم الظاهر غير صالح", 400);
  if (password.length < 12 || password.length > 128) throw fail("كلمة المرور يجب أن تتكون من 12 إلى 128 حرفاً", 400);
  const role = creatingAdmin ? "admin" : body.role === "admin" ? "admin" : body.role === "user" ? "user" : "";
  if (!role) throw fail("حدد صلاحية الحساب", 400);
  return { username, displayName, password, role };
}

function allowAttempt(request, action, maximum) {
  const now = Date.now();
  for (const [key, attempt] of loginAttempts) {
    if (now - attempt.startedAt > 15 * 60 * 1000) loginAttempts.delete(key);
  }
  const address = request.socket.remoteAddress || "unknown";
  const key = `${action}:${address}`;
  const previous = loginAttempts.get(key) || { count: 0, startedAt: now };
  if (previous.count >= maximum) throw fail("محاولات كثيرة. حاول مرة أخرى بعد 15 دقيقة.", 429);
  previous.count += 1;
  if (!loginAttempts.has(key) && loginAttempts.size >= 10_000) {
    loginAttempts.delete(loginAttempts.keys().next().value);
  }
  loginAttempts.set(key, previous);
}

function secureCookie(request) {
  return request.socket.encrypted || process.env.COOKIE_SECURE === "true";
}

function setSessionCookie(request, response, token) {
  const secure = secureCookie(request) ? "; Secure" : "";
  response.setHeader("Set-Cookie", `${sessionCookie}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionLifetime / 1000}${secure}`);
}

function clearSessionCookie(request, response) {
  const secure = secureCookie(request) ? "; Secure" : "";
  response.setHeader("Set-Cookie", `${sessionCookie}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
}

async function createSession(request, response, database, userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  await database.query(
    "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)",
    [crypto.createHash("sha256").update(token).digest("hex"), userId, Date.now() + sessionLifetime],
  );
  setSessionCookie(request, response, token);
}

function assertSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) throw fail("مصدر الطلب مطلوب", 403);
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw fail("مصدر الطلب غير صالح", 403);
  }
  if (parsed.host !== request.headers.host || !["http:", "https:"].includes(parsed.protocol)) {
    throw fail("تم رفض الطلب لمصدره غير الموثوق", 403);
  }
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1024 * 1024) throw fail("حجم البيانات أكبر من الحد المسموح", 413);
  }
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw fail("صيغة JSON غير صالحة", 400);
  }
}

function validDate(value) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function toNumberRows(rows, fields) {
  return rows.map((row) => {
    for (const field of fields) row[field] = Number(row[field]);
    return row;
  });
}

async function pharmacyList(database) {
  const result = await database.query(`
    SELECT p.id, p.name, p.location,
      COALESCE(SUM(CASE WHEN t.type = 'sale' THEN t.amount ELSE 0 END), 0) AS sales,
      COALESCE(SUM(CASE WHEN t.type = 'purchase' THEN t.amount ELSE 0 END), 0) AS purchases,
      COALESCE(SUM(CASE WHEN t.type IN ('income','sale','supply') THEN t.amount WHEN t.type IN ('expense','purchase') THEN -t.amount ELSE 0 END), 0) AS balance,
      COUNT(t.id) AS "transactionCount"
    FROM pharmacies p LEFT JOIN transactions t ON t.pharmacy_id = p.id
    GROUP BY p.id ORDER BY lower(p.name)
  `);
  return toNumberRows(result.rows, ["id", "sales", "purchases", "balance", "transactionCount"]);
}

async function dashboardData(database) {
  const result = await database.query(`
    SELECT
      COALESCE(SUM(CASE WHEN type='sale' THEN amount ELSE 0 END),0) AS sales,
      COALESCE(SUM(CASE WHEN type='purchase' THEN amount ELSE 0 END),0) AS purchases,
      COALESCE(SUM(CASE WHEN type='expense' THEN amount ELSE 0 END),0) AS expenses,
      COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE 0 END),0) AS income,
      COALESCE(SUM(CASE WHEN type='supply' THEN amount ELSE 0 END),0) AS supplies,
      COALESCE(SUM(CASE WHEN type='sale' AND payment_method='credit' THEN amount ELSE 0 END),0) AS "creditSales",
      COALESCE(SUM(CASE WHEN date=CURRENT_DATE AND type='sale' THEN amount ELSE 0 END),0) AS "todaySales",
      COALESCE(SUM(CASE WHEN date=CURRENT_DATE AND type='expense' THEN amount ELSE 0 END),0) AS "todayExpenses",
      COALESCE(SUM(CASE WHEN payment_method='cash' AND type IN ('sale','income','supply') THEN amount WHEN payment_method='cash' AND type IN ('purchase','expense') THEN -amount ELSE 0 END),0) AS "cashBalance",
      COALESCE(SUM(CASE WHEN payment_method='bank' AND type IN ('sale','income','supply') THEN amount WHEN payment_method='bank' AND type IN ('purchase','expense') THEN -amount ELSE 0 END),0) AS "bankBalance",
      COALESCE(SUM(CASE WHEN type IN ('income','sale','supply') THEN amount WHEN type IN ('expense','purchase') THEN -amount ELSE 0 END),0) AS balance
    FROM transactions
  `);
  const count = await database.query("SELECT count(*) AS count FROM pharmacies");
  const months = await database.query(`
    SELECT to_char(date, 'YYYY-MM') AS month,
      SUM(CASE WHEN type='sale' THEN amount ELSE 0 END) AS sales,
      SUM(CASE WHEN type='purchase' THEN amount ELSE 0 END) AS purchases
    FROM transactions WHERE type IN ('sale','purchase')
    GROUP BY month ORDER BY month DESC LIMIT 7
  `);
  const totals = result.rows[0];
  for (const [key, value] of Object.entries(totals)) totals[key] = Number(value);
  return {
    ...totals,
    pharmacyCount: Number(count.rows[0].count),
    months: toNumberRows(months.rows, ["sales", "purchases"]).reverse(),
  };
}

async function transactionsList(database, search) {
  const conditions = [];
  const values = [];
  const requestedTypes = search.get("type")?.split(",").filter(Boolean);
  if (requestedTypes?.length) {
    if (requestedTypes.some((type) => !transactionTypeSet.has(type))) throw fail("نوع الحركة غير صالح", 400);
    values.push(requestedTypes);
    conditions.push(`t.type = ANY($${values.length}::text[])`);
  }
  const pharmacyId = search.get("pharmacyId");
  if (pharmacyId) {
    if (!/^\d+$/.test(pharmacyId)) throw fail("رقم الصيدلية غير صالح", 400);
    values.push(Number(pharmacyId));
    conditions.push(`t.pharmacy_id = $${values.length}`);
  }
  for (const [key, operator] of [["from", ">="], ["to", "<="]]) {
    const date = search.get(key);
    if (date) {
      if (!validDate(date)) throw fail("التاريخ غير صالح", 400);
      values.push(date);
      conditions.push(`t.date ${operator} $${values.length}::date`);
    }
  }
  const result = await database.query(`
    SELECT t.id, t.pharmacy_id AS "pharmacyId", p.name AS "pharmacyName", t.type,
      t.amount, t.date::text AS date, t.description,
      t.payment_method AS "paymentMethod", t.created_at AS "createdAt"
    FROM transactions t JOIN pharmacies p ON p.id = t.pharmacy_id
    ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
    ORDER BY t.date DESC, t.id DESC LIMIT 500
  `, values);
  return toNumberRows(result.rows, ["id", "pharmacyId", "amount"]);
}

async function handleApi(request, response, url, database) {
  const { pathname, searchParams } = url;
  const method = request.method;
  if (pathname === "/api/health" && method === "GET") {
    await database.query("SELECT 1");
    return json(response, 200, { status: "ok", database: "postgresql" });
  }
  if (pathname.startsWith("/api/") && method !== "GET" && method !== "HEAD") assertSameOrigin(request);
  if (pathname === "/api/auth/status" && method === "GET") {
    const user = await requestUser(request, database);
    const count = await database.query("SELECT count(*) AS count FROM users");
    return json(response, 200, { setupRequired: false, user: user ? publicUser(user) : null, accountsAvailable: Number(count.rows[0].count) > 0 });
  }
  if (pathname === "/api/auth/setup" && method === "POST") {
    throw fail("Initial administrator setup is disabled; use the protected local bootstrap script.", 403);
  }
  if (pathname === "/api/auth/login" && method === "POST") {
    allowAttempt(request, "login", 10);
    const body = await readJson(request);
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (username.length > 40 || password.length > 128) throw fail("بيانات تسجيل الدخول غير صحيحة", 401);
    const result = await database.query(
      "SELECT id,username,display_name,password_hash,role FROM users WHERE lower(username)=lower($1)",
      [username],
    );
    const user = result.rows[0];
    if (!user || !(await verifyPassword(password, user.password_hash))) throw fail("اسم المستخدم أو كلمة المرور غير صحيحة", 401);
    loginAttempts.delete(`login:${request.socket.remoteAddress || "unknown"}`);
    await createSession(request, response, database, user.id);
    return json(response, 200, { user: publicUser(user) });
  }
  if (pathname === "/api/auth/logout" && method === "POST") {
    const token = readSessionToken(request);
    if (token) {
      await database.query("DELETE FROM sessions WHERE token_hash=$1", [
        crypto.createHash("sha256").update(token).digest("hex"),
      ]);
    }
    clearSessionCookie(request, response);
    return json(response, 200, { loggedOut: true });
  }

  const user = await requestUser(request, database);
  if (!user) return json(response, 401, { error: "يلزم تسجيل الدخول للمتابعة" });
  const requireAdmin = () => {
    if (user.role !== "admin") throw fail("تتطلب هذه العملية صلاحية المدير", 403);
  };

  if (pathname === "/api/users" && method === "GET") {
    requireAdmin();
    const result = await database.query(`
      SELECT id,username,display_name AS "displayName",role,created_at AS "createdAt"
      FROM users ORDER BY created_at DESC,id DESC
    `);
    return json(response, 200, result.rows);
  }
  if (pathname === "/api/users" && method === "POST") {
    requireAdmin();
    const account = validateAccount(await readJson(request));
    const passwordHash = await hashPassword(account.password);
    try {
      const result = await database.query(
        `INSERT INTO users(username,display_name,password_hash,role)
         VALUES($1,$2,$3,$4) RETURNING id,username,display_name AS "displayName",role,created_at AS "createdAt"`,
        [account.username, account.displayName, passwordHash, account.role],
      );
      return json(response, 201, result.rows[0]);
    } catch (error) {
      if (error.code === "23505") throw fail("اسم المستخدم مسجل بالفعل", 409);
      throw error;
    }
  }
  const userMatch = pathname.match(/^\/api\/users\/(\d+)$/);
  if (userMatch && method === "DELETE") {
    requireAdmin();
    const targetId = Number(userMatch[1]);
    if (targetId === Number(user.id)) throw fail("لا يمكنك حذف حسابك أثناء تسجيل الدخول", 400);
    const target = await database.query("SELECT id,role FROM users WHERE id=$1", [targetId]);
    if (!target.rowCount) return json(response, 404, { error: "المستخدم غير موجود" });
    if (target.rows[0].role === "admin") {
      const admins = await database.query("SELECT count(*) AS count FROM users WHERE role='admin'");
      if (Number(admins.rows[0].count) <= 1) throw fail("لا يمكن حذف آخر حساب مدير", 409);
    }
    await database.query("DELETE FROM users WHERE id=$1", [targetId]);
    return json(response, 200, { deleted: true });
  }
  if (pathname === "/api/dashboard" && method === "GET") return json(response, 200, await dashboardData(database));
  if (pathname === "/api/pharmacies" && method === "GET") return json(response, 200, await pharmacyList(database));
  if (pathname === "/api/pharmacies" && method === "POST") {
    requireAdmin();
    const body = await readJson(request);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const location = typeof body.location === "string" ? body.location.trim() : "";
    if (!name || name.length > 120 || location.length > 200) throw fail("أدخل اسم صيدلية صحيحاً وعنواناً لا يتجاوز 200 حرف", 400);
    try {
      const result = await database.query("INSERT INTO pharmacies(name,location) VALUES($1,$2) RETURNING id", [name, location]);
      return json(response, 201, { id: Number(result.rows[0].id), name, location });
    } catch (error) {
      if (error.code === "23505") throw fail("اسم الصيدلية مسجل بالفعل", 409);
      throw error;
    }
  }
  const pharmacyMatch = pathname.match(/^\/api\/pharmacies\/(\d+)$/);
  if (pharmacyMatch && method === "DELETE") {
    requireAdmin();
    const result = await database.query("DELETE FROM pharmacies WHERE id=$1", [Number(pharmacyMatch[1])]);
    if (!result.rowCount) return json(response, 404, { error: "الصيدلية غير موجودة" });
    return json(response, 200, { deleted: true });
  }
  if (pathname === "/api/transactions" && method === "GET") {
    return json(response, 200, await transactionsList(database, searchParams));
  }
  if (pathname === "/api/transactions" && method === "POST") {
    requireAdmin();
    const body = await readJson(request);
    const pharmacyId = Number(body.pharmacyId);
    const amount = Number(body.amount);
    const date = body.date;
    const description = typeof body.description === "string" ? body.description.trim() : "";
    const paymentMethod = body.paymentMethod || "cash";
    if (!Number.isSafeInteger(pharmacyId) || pharmacyId < 1) throw fail("اختر صيدلية صحيحة", 400);
    if (!transactionTypeSet.has(body.type)) throw fail("نوع الحركة غير صالح", 400);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000_000) throw fail("يجب أن يكون المبلغ أكبر من صفر", 400);
    if (!validDate(date)) throw fail("أدخل تاريخاً صحيحاً", 400);
    if (description.length > 300) throw fail("الوصف أطول من الحد المسموح", 400);
    if (!paymentMethodSet.has(paymentMethod)) throw fail("طريقة الدفع غير صالحة", 400);
    const result = await database.query(
      "INSERT INTO transactions(pharmacy_id,type,amount,date,description,payment_method) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",
      [pharmacyId, body.type, amount, date, description, paymentMethod],
    );
    return json(response, 201, { id: Number(result.rows[0].id) });
  }
  const transactionMatch = pathname.match(/^\/api\/transactions\/(\d+)$/);
  if (transactionMatch && method === "DELETE") {
    requireAdmin();
    const result = await database.query("DELETE FROM transactions WHERE id=$1", [Number(transactionMatch[1])]);
    if (!result.rowCount) return json(response, 404, { error: "الحركة غير موجودة" });
    return json(response, 200, { deleted: true });
  }
  return json(response, 404, { error: "المسار غير موجود" });
}

function serveStatic(response, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return json(response, 400, { error: "مسار غير صالح" });
  }
  const relativePath = decoded === "/" ? "index.html" : decoded.replace(/^[/\\]+/, "");
  if (!publicFiles.has(relativePath)) return json(response, 404, { error: "المسار غير موجود" });
  const filePath = path.resolve(root, relativePath);
  if (!filePath.startsWith(`${root}${path.sep}`)) return json(response, 403, { error: "الوصول مرفوض" });
  fs.readFile(filePath, (error, data) => {
    if (error) return json(response, error.code === "ENOENT" ? 404 : 500, { error: "تعذر قراءة الملف" });
    response.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    response.end(data);
  });
}

function createHttpServer(database) {
  return http.createServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
      if (url.pathname.startsWith("/api/")) {
        await handleApi(request, response, url, database);
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        json(response, 405, { error: "الطريقة غير مسموحة" });
        return;
      }
      serveStatic(response, url.pathname);
    } catch (error) {
      json(response, error.status || 500, { error: error.status ? error.message : "حدث خطأ داخلي في الخادم" });
      if (!error.status) console.error("Request failed:", error.message);
    }
  });
}

async function startServer({ database, port = Number(process.env.PORT || 3000), host = process.env.HOST || "0.0.0.0" } = {}) {
  if (process.env.NODE_ENV === "production" && process.env.COOKIE_SECURE !== "true") {
    throw new Error("COOKIE_SECURE=true is required in production");
  }
  if (!database) {
    await migrate();
    database = getPool();
  }
  await database.query("SELECT 1");
  const server = createHttpServer(database);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return server;
}

if (require.main === module) {
  startServer().then((server) => {
    console.log(`Pharmacy PostgreSQL demo listening on ${server.address().port}`);
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.on(signal, () => {
        server.close(async () => {
          await closePool();
          process.exit(0);
        });
      });
    }
  }).catch(async (error) => {
    console.error("Application startup failed:", error.message);
    await closePool();
    process.exitCode = 1;
  });
}

module.exports = { createHttpServer, startServer, validateAccount, verifyPassword };
