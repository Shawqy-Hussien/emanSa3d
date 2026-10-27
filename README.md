# Pharmacy management

An Arabic, right-to-left pharmacy management app served by a small Node.js API and a persistent SQLite database, with admin-managed accounts and session-based authentication.

## Requirements

- Node.js 22.5 or newer (uses the built-in `node:sqlite` module).

## Run

```powershell
npm start
```

Open [http://localhost:3000](http://localhost:3000). The database is created automatically at `data/pharmacy.sqlite`. No demo records are inserted. Existing database records are preserved.

### Open the app on a phone (same Wi-Fi)

1. Connect the phone and this PC to the same trusted Wi-Fi network.
2. Find the PC's IPv4 address with `ipconfig` (look for **IPv4 Address** under the Wi-Fi adapter).
3. On the phone, open `http://<PC-IPv4-address>:3000`, for example `http://192.168.1.12:3000`.
4. Keep `npm start` running on the PC while using the app.

The server listens on network interfaces so devices on your local network can connect. Do not expose port 3000 to the public internet or use the app to send passwords on public/untrusted Wi-Fi. If Windows Firewall blocks the connection, mark only a trusted home Wi-Fi network as **Private**, then create a Private-profile inbound TCP rule for local-network devices on port 3000. On the phone browser, use **Add to Home Screen** for a convenient shortcut.

To restrict the server to a particular interface, set `HOST` before starting it, for example `$env:HOST = "192.168.1.12"`. The default is `0.0.0.0`.

## Accounts and permissions

- On the first visit, create the initial administrator account. This one-time setup closes as soon as the first account is created.
- Administrators sign in and create additional user, branch-manager, or administrator accounts from **المستخدمون**. Non-administrator accounts are assigned to one pharmacy and can receive separate permissions to view branch data, record transactions, close their assigned shifts, manage shifts across their branch, and delete transactions from their branch. Administrators have all permissions and can access all branches and manage accounts and pharmacies.
- Administrators set each branch's recurring daily shift schedule (one or more named, non-overlapping time ranges) when creating the branch. Every sale must select one of that branch's recurring shifts. Administrators and accounts granted `manage_shifts` can also create, edit, and delete dated shifts in their permitted scope and assign shifts to a user in that branch. Accounts granted `close_shifts` can close their own dated shifts once; accounts granted `manage_shifts` can correct closed shift sales totals within their branch. Dashboard and branch sales totals add dated shift-closing amounts to individually recorded sale transactions; shift-closing amounts are not assigned to a payment method. Shift times are on the same date, and a user cannot be assigned overlapping dated shifts.
- Passwords must be at least 12 characters and are stored using Node.js `scrypt` with a unique random salt.
- Login uses an `HttpOnly`, `SameSite=Strict` session cookie. Login and first-admin setup are rate limited; state-changing API requests validate their origin.
- For HTTPS behind a reverse proxy, set `COOKIE_SECURE=true` so session cookies always include the `Secure` flag.

To use a separate SQLite file, set `DATABASE_PATH` before starting the server. For example:

```powershell
$env:DATABASE_PATH = "C:\path\to\pharmacy.sqlite"
npm start
```

## API

- `GET /api/health`
- `GET /api/auth/status`
- `POST /api/auth/setup` (one-time initial admin)
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/dashboard` (requires `view_data`)
- `GET /api/shift-analytics` (requires `view_data`; monthly sales totals and per-day averages for recurring branch shifts, comparing the current month to the previous month)
- `GET, POST /api/pharmacies` (write access: administrator; creation requires `shiftTemplates`, an array of 1–12 named, non-overlapping daily time ranges)
- `DELETE /api/pharmacies/:id` (administrator; also deletes that pharmacy's transactions)
- `GET /api/transactions` (requires `view_data`; supports `type`, `pharmacyId`, `paymentMethod`, `from`, and `to` filters)
- `POST /api/transactions/:type` (requires `record_transactions`; fixed type: `sale`, `purchase`, `expense`, `income`, `supply`, or `adjustment`; sales require a branch `shiftTemplateId` or, for legacy clients, an open dated `shiftId`; new sales can include a `paymentSplits` object whose method amounts sum to the sale total; non-administrators are restricted to their assigned branch)
- `POST /api/transactions` (legacy compatible transaction creation endpoint)
- `DELETE /api/transactions/:id` (requires `delete_transactions`; non-administrators are restricted to their assigned branch)
- `GET, POST /api/users`, `PUT /api/users/:id`, and `DELETE /api/users/:id` (administrator; updates can change account details, role, branch, permissions, and optionally the password)
- `GET /api/shifts` (requires `view_data`; users see their own shifts unless granted `manage_shifts`, which shows all shifts for their branch; optional `pharmacyId` and `date` filters)
- `GET /api/branch-users` (requires `manage_shifts`; lists users assigned to the manager's branch)
- `POST /api/shifts`, `PUT /api/shifts/:id`, and `DELETE /api/shifts/:id` (requires `manage_shifts`; branch managers are restricted to their assigned branch)
- `POST /api/shifts/:id/close` (assigned user with `close_shifts` closes a shift once; users with `manage_shifts` can close or correct shifts in their branch; administrators can correct any shift)

Each transaction type has a separate page, entry form, and independent filter state. A sale requires selecting one of the recurring shifts defined for its branch; the selected branch shift template is stored with the sale and shown in transaction history. Dated shifts can still be created and assigned to users for shift scheduling and closing. The legacy API also accepts an open dated shift ID for sale transactions. Non-administrators are automatically restricted to their assigned branch; administrators can select any branch. Filter transactions with `type`, `pharmacyId`, `paymentMethod`, `from`, and `to` query parameters.

The Shifts page compares each recurring branch shift's sales total and average daily sales for the current month-to-date against the full previous month, with charts and a summary table. Branch-restricted accounts see only their assigned branch.

Payment methods are cash, Visa, InstaPay, Vodafone (Dr. Ahmed), and Vodafone (pharmacy). Sales can be split across multiple payment methods; the split amounts must add up to the sale total and update each method's balance while remaining a single sale in transaction history. Supply transactions must select Visa, InstaPay, or one of the Vodafone methods as their source: the amount is subtracted from that method's balance and added to cash. Supplies are internal transfers, so they do not increase the overall branch balance. Dashboard balances update from recorded transactions for each method. Existing bank and credit transaction records are preserved and remain visible in transaction history.
