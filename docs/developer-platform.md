# Developer authentication and managed API (implementation branch)

This feature is isolated from the existing public map. No production deployment has been run.

## Routes

- `/` and existing `/style.json`, `/tiles/*`, `/api/v1/route`, sprite/font routes: unchanged and public.
- `/dashboard`: developer login and key-management UI.
- `/auth/google`, `/auth/github`: OAuth authorization; `/auth/callback/{provider}`: callbacks.
- `/api/developer/register`, `login`, `logout`, `me`, `keys`, `usage`: same-origin session endpoints.
- `/api/managed/v1/status`: proof-of-concept authenticated endpoint using `Authorization: Bearer sm_...`.

**Existing public map APIs are not placed behind API keys.** The managed status endpoint is a new, separate example. Other API products need to be explicitly designed and added.

## Provisioning required before preview/deployment

1. Create a dedicated Cloudflare D1 database. Apply `worker/migrations/0001_developers.sql` using Wrangler D1 migrations or execute it against the new database.
2. Add a D1 binding named `DB` to `worker/wrangler.jsonc` with the **actual** D1 database name and ID from your account. No invented ID has been committed.
3. Configure Cloudflare Worker secrets `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` for the target environment. Do not commit them.
4. Register exact OAuth callback URLs:
   - `https://<your-host>/auth/callback/github`
   - `https://<your-host>/auth/callback/google`
5. Test on a preview deployment with an isolated D1 database before any production deployment.

## Security and current limits

- Passwords use PBKDF2-HMAC-SHA256 with a unique salt; sessions and API keys are stored as SHA-256 hashes.
- Session cookies are HttpOnly, Secure, SameSite=Lax, expire after seven days, and mutations require a same-origin Origin header.
- OAuth uses short-lived, single-use state. Google authorization uses PKCE. OAuth accounts are **not** automatically linked to existing password accounts with the same email.
- New API keys are displayed once, limited to 10 active keys per account, expire after 90 days, and can be revoked.
- Managed status endpoint reserves a quota atomically in D1. Current example quota is 10,000 requests per key per UTC day.
- The dashboard is a standalone static HTML page; it does not change the map UI.

**Not production-ready yet:** Email verification, password reset/recovery, login/signup abuse protection, account deletion, OAuth account linking, organization roles, comprehensive auditing, and real API-product scope enforcement are not implemented. Do not expose registration publicly before rate limiting/anti-abuse and verification are completed. D1 binding and OAuth credentials are not configured in this branch.

## Smoke checks before deployment

- Verify the public map route and existing public APIs return the same responses as `main`.
- Verify missing D1 returns 503 only for developer/managed endpoints, not the map.
- Test registration, invalid login, session cookie, logout, key creation/list/revocation, key expiry, daily quota and OAuth callbacks.
- Confirm that `/dashboard` never caches credentials and that no secrets appear in client-side code.
