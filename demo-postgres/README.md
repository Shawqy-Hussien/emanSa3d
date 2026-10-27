# Isolated PostgreSQL demo

This is a separate PostgreSQL-backed version of the pharmacy API. It serves the
existing root-level `index.html`, `app.js`, and `styles.css` as read-only assets;
it does not edit those files or change dashboard cards. The existing
`data/pharmacy.sqlite` is an import source only and is never opened for writes.

## Requirements

- Node.js 22.5 or newer.
- A local PostgreSQL instance for local development, or a PostgreSQL database
  provided separately for a future deployment.
- PowerShell examples below assume the shell is in the workspace root.

## Local setup

Create a new, empty PostgreSQL database for the demo (do not point it at an
existing or production database). Then set its URL in the current PowerShell
session. Replace the placeholder password locally; do not paste credentials in
tracked files or logs.

```powershell
npm ci --prefix demo-postgres
$env:DATABASE_URL = "postgresql://postgres:REPLACE_ME@localhost:5432/pharmacy_demo"
$env:PGSSL = "disable"
npm --prefix demo-postgres run migrate
```

To copy only the dummy business records into that database:

```powershell
npm --prefix demo-postgres run import:sqlite
```

Before connecting to PostgreSQL, the import command makes a separate SQLite
backup at `demo-postgres/local/pharmacy-source-backup.sqlite`, verifies SQLite
integrity and business-table row counts, and leaves the source file untouched.
The import reads only `pharmacies` and `transactions` from the verified backup;
it never queries source users or sessions and does not import them into
PostgreSQL. The SQLite backup itself is a full-file safety copy and therefore
contains the SQLite database's existing tables. Treat it as sensitive: it
remains in the ignored local-only directory, is not logged or deployed, and
must be kept private. The importer refuses to proceed if any user-defined
PostgreSQL table contains records, and uses a locked transaction for the
destination check and import.

Create fresh dummy accounts after import:

```powershell
npm --prefix demo-postgres run bootstrap:demo
```

This creates `demo-admin` and `demo-viewer` with newly generated passwords.
Their credentials are written once to
`demo-postgres/local/generated-demo-credentials.json`; they are not printed.
Keep that file private. The public first-admin endpoint is disabled. The
bootstrap script refuses to run if users or sessions already exist.

Start the isolated app:

```powershell
$env:PORT = "3000"
$env:COOKIE_SECURE = "false"
npm --prefix demo-postgres start
```

Open `http://localhost:3000`. The application uses the original frontend files
as read-only static assets. Stop the server with Ctrl+C.

## Automated tests

Tests reset the **entire public schema** in the configured test database. Use
only a separate, disposable PostgreSQL database on the local machine with
`test` in its database name (for example `pharmacy_demo_test`). Never configure
this to a hosted database or a database containing data you need. The suite
does not fall back to `DATABASE_URL`; it verifies the local hostname and
database name, compares the target against `DATABASE_URL`, checks the connected
database identity, and requires an explicit reset opt-in before dropping the
schema.

```powershell
$env:TEST_DATABASE_URL = "postgresql://postgres:REPLACE_ME@localhost:5432/pharmacy_demo_test"
$env:TEST_PGSSL = "disable"
$env:ALLOW_TEST_DATABASE_RESET = "YES"
npm --prefix demo-postgres test
```

The tests create temporary test users and records in that disposable test
database only. They cover migrations and constraints, login/session behavior,
admin versus viewer permissions, CRUD/cascade behavior, and server startup and
health. Do not set `DATABASE_URL` to the test URL when using the test runner.

## PostgreSQL schema and data mapping

`migrations/001_initial_schema.sql` defines the existing pharmacy, transaction,
user, and session concepts. It preserves the transaction type and payment
method checks, foreign-key cascades, indexes, and case-insensitive unique
usernames. IDs use PostgreSQL identities; transaction amounts use
`NUMERIC`, transaction dates use `DATE`, creation times use
`TIMESTAMPTZ`, and session expiration remains Unix milliseconds in `BIGINT`.
The demo import preserves existing pharmacy and transaction IDs and advances
their identity sequences. User IDs/password hashes and all sessions are not
imported.

Migration execution is versioned and guarded with a PostgreSQL advisory lock.
The application applies pending migrations before accepting requests. The
health route checks database connectivity and returns no connection details.

## Future Render + Neon demo deployment (not performed)

The root `render.yaml` describes a Render Free web service. It uses the
repository root so the isolated server can serve the unchanged frontend.
Render deploys from a connected Git repository; this workspace is currently
not a Git repository, so a Git remote/repository will be required before a
future deployment. This phase creates no account or cloud resource.

After separate approval and manual provisioning:

1. Create a Neon demo project/database and a Render web service from the
   approved repository. Use the Render blueprint or equivalent settings:
   `npm ci --prefix demo-postgres` for build and
   `npm --prefix demo-postgres start` for start.
2. Set Render environment variables in its secret/environment settings:
   `DATABASE_URL` to Neon’s connection URL, `NODE_ENV=production`,
   `COOKIE_SECURE=true`, and the Render-provided `PORT`. Do not put database
   credentials in `render.yaml`, Git, or command output.
3. Use the Neon connection string with TLS enabled and certificate verification.
   Run migrations, business-data import, and dummy-account bootstrap only
   against the newly created demo database. The import command first creates
   and verifies a separate local SQLite backup. Keep the generated credential
   file local and deliver demo passwords through a private channel.
4. Verify `/api/health`, static page delivery, admin/viewer login, read/write
   permissions, and dashboard values before sharing the Render HTTPS URL.

Production settings require `DATABASE_URL`, `PORT`, `NODE_ENV=production`, and
`COOKIE_SECURE=true`. Render terminates HTTPS; cookies are marked `Secure`.
PostgreSQL is the durable store. The application does not persist user data on
Render's local filesystem, which is ephemeral. Keep generated credentials and
SQLite backups local; they are not deployed.

### Free-tier limitations and costs

- Render's current free web services sleep after 15 minutes without inbound
  traffic and may take about a minute to wake. They have ephemeral filesystems,
  and free hours, bandwidth, and build minutes are limited. No persistent disk
  or dependable always-on availability is assumed.
- Neon Free currently lists 100 compute-unit hours per project, 1 GB storage
  per project, automatic scale-to-zero after inactivity, and a six-hour
  history window. Quotas and plan terms can change; verify them at setup.
- Expected platform cost is $0 only while both services remain within their
  current free quotas. Exceeding quotas, selecting paid plans, or changing
  provider terms may incur charges. This is a temporary demo, not a
  production-grade backup or availability arrangement.
- Free service sleep causes cold-start delays; Neon scale-to-zero may add
  database wake latency. The app performs readiness queries and does not rely
  on local durable storage.
- A public demo URL is accessible to anyone. Use dummy data/accounts only,
  restrict or remove public access when no longer needed, and never reuse
  passwords.
- Login throttling is in-memory and per process; it resets on restart/sleep.
  Behind a hosting proxy, client-IP attribution may also require provider-
  specific trusted-proxy handling. This demo is not hardened for sensitive or
  production authentication workloads.

Provider references: [Render free instances](https://render.com/docs/free),
[Render PostgreSQL connection](https://render.com/docs/postgresql-creating-connecting),
and [Neon pricing](https://neon.com/pricing).

## Scope and safety

This package is additive. It does not import or access old user records,
password hashes, or sessions, does not overwrite the original application,
does not change frontend files/metrics, and does not deploy. The SQLite
business-data import is an explicit manual command and only runs after making
and verifying its separate backup. No cloud setup or deployment is included in
this implementation.
