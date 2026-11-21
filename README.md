# Nance Oro Dental

The staff app signs employees in with an employee ID, password, and a fresh device location inside the selected clinic branch's fixed 100 metre radius. GPS accuracy may be up to 100 metres. Because the boundary uses the reported GPS coordinates, a fix with high uncertainty can place a device outside its true location; admin works on desktop and phone, while staff use the desktop app.

The existing pharmacy-shaped Supabase project remains the shared database. Dashboard, inventory, and bills read the existing `branches`, `medicines`, `batches`, `sales`, and `sale_items` tables. Supplier and purchase writes use the added `suppliers`, `purchases`, and `purchase_items` tables; receiving a purchase creates its batch and stock movement atomically.

## Enable cloud writes and 100 m staff sign-in

1. In the connected Supabase project's **SQL Editor**, run [`supabase/staff-location-migration.sql`](./supabase/staff-location-migration.sql), [`supabase/staff-radius-100m-migration.sql`](./supabase/staff-radius-100m-migration.sql), then [`supabase/write-sync-migration.sql`](./supabase/write-sync-migration.sql). The staff migrations add clinic coordinates, employee fields, the sign-in audit table, and the 100 m radius/accuracy limits. The write-sync migration adds supplier/purchase storage and transactional purchase/sale functions.
2. On the app server only, set the Supabase service-role key and admin credentials in `.env` or the hosting provider's secret manager:

   ```dotenv
   SUPABASE_SERVICE_ROLE_KEY=your-server-only-service-role-key
   ADMIN_USERNAME=your-admin-login
   ADMIN_PASSWORD=a-random-password-at-least-10-characters
   ```

   Keep the existing `SUPABASE_URL` and `SUPABASE_ANON_KEY`. Never put `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_PASSWORD`, or any server secret in browser code, an APK, or a committed file. The service-role key bypasses Supabase RLS and must remain server-side.
3. Restart the Node server and check `/api/health` and `/api/dental/health`. Both should report the Supabase migrations and writes are enabled.
4. To copy the saved local demo history, run `node supabase/import-local-state.mjs` on the server after both migrations are installed. This imports suppliers, purchases, bills, and clinic locations idempotently. The saved inventory quantities are archived for reference but are not added to live stock, avoiding duplicate stock on top of existing Supabase batches.
5. The saved local employee IDs are retained as import notes, but their old local password hashes cannot be converted into Supabase Auth credentials. In Admin → Employees, create them again with IDs `EMP001` and `002`, assign a clinic, and set fresh initial passwords of at least 12 characters. Their sign-ins then use Supabase Auth and are recorded in `staff_signins`.
6. Test staff sign-in online at the assigned branch. A successful sign-in requires a fresh GPS fix with accuracy of 100 m or better and is recorded before access is granted.

The server defaults to binding only to `127.0.0.1`. For a hosted deployment, configure the hosting platform to bind the server appropriately behind HTTPS, and do not expose the Node process or service-role key directly to the internet. HTTPS is required for browser geolocation on non-localhost devices.

## Data and security notes

- Employee profiles are linked to Supabase Auth user IDs and use a `DENTAL_STAFF` role. Restrictive RLS policies prevent these accounts from reading or writing pharmacy branch, stock, and sales records. Employee passwords are managed by Supabase Auth; the app never stores plaintext passwords or password hashes in `profiles`.
- Successful cloud staff sign-ins are recorded in `staff_signins`; localhost-only sign-ins are recorded in the local state file. Both record measured distance and accuracy, not exact GPS coordinates.
- Staff bills are written to Supabase and appear in the admin bills page only when the server-side service-role key and write-sync migration are enabled. In local fallback mode they are saved in the shared local state; when Supabase is configured read-only, those local bills do not appear in the cloud-backed admin dashboard.
- New clinic locations use the existing `branches` table. The explicit local-state import updates matching branches with the saved coordinates; otherwise locations are managed in the authenticated admin app.
- **Offline sign-in is not enabled in this write-synchronized version.** A verified sign-in requires internet access so the server can check the password and location and durably record the event in Supabase.
- Supplier and purchase mutations require an authenticated admin session, same-origin requests, the server-only service key, and the write-sync migration. Purchase receipt is a single database transaction that stores the purchase, batch, and stock movement together.
- The legacy inventory and bill pages read from the existing pharmacy tables. The saved local inventory snapshot is not added as extra stock by the import script; the existing Supabase inventory remains the live count until stock is received through the purchase form.
- If the service-role key is absent, Supabase remains read-only. `localhost` is not shareable; deploy behind HTTPS before employees use the app from other devices.
