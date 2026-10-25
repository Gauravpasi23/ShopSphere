# ShopSphere

ShopSphere is an Express/MongoDB storefront with a separately authenticated analytics dashboard.

## Run on Windows

Open PowerShell in this project folder and install dependencies if needed:

```powershell
npm.cmd install
```

Start the complete app:

```powershell
npm.cmd start
```

Open `http://localhost:3000` for the storefront. The app uses a temporary MongoDB instance when `MONGODB_URI` is blank; its data disappears when the process stops. Add a MongoDB connection string to `.env` to persist products, events, orders, and sessions.

The frontend and Express API run together in this single server; no second frontend terminal is required. The catalog seed inserts missing demo products without deleting or replacing existing products.

## Customer shopping and account pages

- Storefront: `http://localhost:3000/`
- Sign in / registration: `http://localhost:3000/login`
- Customer profile: `http://localhost:3000/account/profile`
- Edit account details: `http://localhost:3000/account/edit`
- Customer orders: `http://localhost:3000/account/orders`
- Saved addresses: `http://localhost:3000/account/addresses`
- Change password: `http://localhost:3000/account/password`
- Cart: `http://localhost:3000/cart`
- Checkout: `http://localhost:3000/checkout`
- Admin analytics: `http://localhost:3000/admin/login`

Customer account, cart, wishlist, and order APIs use the signed-in server session. Guest cart and wishlist items are kept in that browser's local storage; once a customer signs in, those items are merged into their MongoDB account. Demo Card is a simulated method only; it does not collect card information or charge a payment.

Newsletter opt-ins are stored as normalized email addresses in MongoDB and are rate-limited. No email delivery provider is configured, so the app records subscriptions but does not send newsletters.

To initialize or change the admin password, generate a bcrypt hash with `npm.cmd run admin:hash` and set `ADMIN_EMAIL` and `ADMIN_PASSWORD_HASH` in the private `.env` file. Never put a plain password in `ADMIN_PASSWORD_HASH` or commit `.env`.

## Configure admin access

1. Copy the sample environment file:

   ```powershell
   Copy-Item .env.example .env
   ```

2. In the project folder, generate a password hash. Enter the admin password when prompted; it will not be displayed:

   ```powershell
   npm.cmd run admin:hash
   ```

   Copy the complete `ADMIN_PASSWORD_HASH=...` output into `.env`. Set `ADMIN_EMAIL` to the admin login email. The password itself is never put in `.env`.

3. Generate a session secret:

   ```powershell
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

   Put the output after `SESSION_SECRET=` in `.env`.

4. To enable Matomo, set `MATOMO_URL` to the Matomo base URL (for example, `https://analytics.example.com/`) and `MATOMO_SITE_ID` to the site ID in Matomo. Leave these blank to disable Matomo; consented MongoDB event tracking still works.

5. Restart the server and visit `http://localhost:3000/admin/login`. Sign in with the `ADMIN_EMAIL` and the password used to generate the hash.

`.env` is ignored by Git. Never share or commit it. For production, also set `NODE_ENV=production`, use HTTPS, a strong `SESSION_SECRET`, a persistent MongoDB database, and an appropriately configured Matomo URL/site ID. Production cookies are marked secure.

## Analytics and privacy

The storefront asks visitors for analytics consent before sending events. Events use a browser-tab session identifier, page path, event type, and limited product/category/action information. Raw searches, form values, email addresses, addresses, payment information, IP addresses, and visitor geography are not stored in analytics records.

Dashboard APIs require the admin session. The dashboard’s MongoDB metrics include consented store events and confirmed order totals. Device/browser groups are approximate classifications from the request user-agent. Unique sessions are browser-tab sessions, not a deduplicated person count. Matomo receives page views, selected interactions, and confirmed ecommerce orders directly from the browser after consent. MongoDB events do not automatically appear in Matomo. Matomo reporting may be delayed by its own processing.

## Test

```powershell
npm.cmd test
```
