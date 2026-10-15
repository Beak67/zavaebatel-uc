# Security audit report — ZAVAEBATEL UC

**Reviewed branch:** `security/audit-safe-storefront`  
**Latest successful CI for application/test code:** [Run #136](https://github.com/Beak67/zavaebatel-uc/actions/runs/38695485546) passed on branch HEAD `8bffea952032da7b254ba2a3e940a5d32352bfe5`. `npm ci`, syntax checks, `npm test` (17/17), and `npm audit --omit=dev` succeeded; npm reported 0 vulnerabilities in production dependencies. The regression test runs a real Express test server, asserts the HTTP response from the Express error middleware, and both smoke and authenticated-admin integration tests set `SBP_ENABLED=true`. Subsequent README/audit-report commits are documentation-only; application code, tests and lockfile have not changed.  
**Scope limitation:** this is a repository/code review plus CI evidence, not a production penetration test or a certification of production readiness.

## Executive summary

The current branch intentionally runs in a safe, non-transactional mode. Order creation, receipt upload, payment instructions, order-state changes, payment confirmation and UC fulfillment are disabled in code and return HTTP 503 (payment info explicitly says disabled), independent of `SBP_ENABLED=true`. Run #136 passed the application and test code checks described above. No production deployment, production database access/mutation, real payment, receipt upload, Nexus order or UC fulfillment was performed.

**Recommendation:** eligible for human final review of the branch; **not production-ready**. Keep business operations disabled.

## Review findings and current controls

### Administrative authorization
- Admin API routes require configuration and a PostgreSQL-backed session; protected data routes also require `isAdmin === true`.
- Login compares passwords using `crypto.timingSafeEqual` through a length-checked helper and regenerates the session ID on success.
- Login is rate-limited. Admin write routes require both an authenticated session and a CSRF token.
- Admin state-changing/fulfillment endpoint is a deliberate 503 guard, including for authenticated sessions.
- Integration test covers unauthenticated access, wrong Origin, incorrect password, successful test login, cookie attributes, CSRF rejection, logout and disabled fulfillment.
- **Not verified:** actual production admin credentials, domain-level login, operational account recovery or a second factor. The app currently has a single shared admin password, not a user/role management system.

### SQL and PostgreSQL
- Queries that include request-controlled identifiers use PostgreSQL parameters (`$1`, `$2`); order IDs are format-validated before lookup.
- Database schema verification is fail-closed. Session store table auto-creation is disabled by default; schema initialization is an explicit opt-in.
- Migration is additive and does not drop tables, truncate data or rewrite order status.
- Remote PostgreSQL TLS uses certificate verification (`rejectUnauthorized: true`).
- **Not verified:** production schema compatibility, database role least privilege, backup/restore, migration execution against existing data or operational availability.

### Sessions, cookies, CSRF and headers
- No `express-session` MemoryStore fallback; the PostgreSQL store is required.
- Session cookie is `HttpOnly`, `SameSite=Strict`, `Secure` in production, with a four-hour maximum age and no rolling refresh.
- Login checks Origin against Host; admin mutations require a per-session CSRF token.
- Helmet CSP has `script-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'` and `form-action 'self'`; inline scripts are not permitted. Inline styles are permitted by the current `style-src` directive for the embedded page styles.
- **Residual concern:** Origin-vs-Host validation is not a substitute for validating the externally configured canonical origin. Confirm that the production host/proxy configuration is correct and test the exact deployed behavior.

### Reverse proxy and HTTPS
- Express trusts forwarded headers only when a valid `TRUST_PROXY_HOPS` value from 1 through 5 is configured; production admin routes fail closed if it is not.
- The template value `1` is only a proposed value and has not been validated against Render's actual proxy topology. Wrong hop counts can affect IP-based rate limiting and secure-cookie behavior.
- **Owner action required:** verify the service's actual trusted proxy chain and HTTPS termination in Render before any deployment.

### Static files, routing and errors
- Static middleware serves only `public/`; `/admin` is an explicit route for the root-level `admin.html`. Smoke tests verify expected public assets work and root project files such as `server.js`, `package.json`, `.env`, README and `admin.html` are not served as arbitrary static paths.
- Unknown API and page routes return controlled 404 responses. Error middleware emits generic client-facing errors and logs error type/code rather than request secrets or database connection strings.
- JSON body size is limited; Helmet security headers and no-cache behavior are used for sensitive admin data.
- **Residual concern:** audit logs are not yet an implemented, append-only trail for attempted admin actions; the `admin_audit` table exists in the schema but safe-mode actions are rejected before being recorded. Do not treat it as a complete operational audit facility.

### Nexus and catalog handling
- Catalog product IDs are restricted to PUBG Mobile UC IDs; prices are validated as finite positive numbers before server-side calculation.
- Supplier retries are bounded; malformed JSON and non-success responses are handled. Authorization values are not intentionally included in logs or client responses.
- **Not verified:** actual Nexus API contract, token permissions, upstream response behavior or production price correctness. CI uses stubs and does not contact Nexus.

### Dependencies, configuration and secrets
- `package-lock.json` is present with lockfile version 3. Run #136 successfully executed `npm ci` against this lockfile.
- Run #136 successfully ran `npm audit --omit=dev` and reported 0 vulnerabilities in production dependencies. This checks production dependencies known to npm at run time; it does not prove that the entire application has no vulnerabilities, and it does not audit development dependencies.
- `.env.example` contains empty placeholders, not live credentials. No production environment variables were accessed.
- **Not verified:** independent secret scanning of all Git history, private Render configuration, token rotation status or dependencies against advisories published after the CI run.

## Verification evidence

Run #136: [https://github.com/Beak67/zavaebatel-uc/actions/runs/38695485546](https://github.com/Beak67/zavaebatel-uc/actions/runs/38695485546)

All relevant workflow steps completed successfully on branch HEAD `8bffea952032da7b254ba2a3e940a5d32352bfe5`:
1. `npm ci` — success; lockfile v3 accepted
2. `node --check server.js && node --check public/admin.js && node --check public/storefront.js` — success
3. `npm test` — success, 17 tests passed and 0 failed; PostgreSQL-backed integration tests use an ephemeral PostgreSQL 16 service
4. `npm audit --omit=dev` — success; 0 vulnerabilities reported in production dependencies

The async error regression test starts a real Express test server, invokes a route wrapped by `asyncHandler` that rejects, and asserts that the Express error middleware receives the error and returns the expected HTTP 500 JSON response. Both smoke and authenticated-admin integration tests set `SBP_ENABLED=true`; safe-mode route tests confirm order creation and receipt upload return 503 and payment info remains disabled, and the authenticated fulfillment route returns 503.

For run #114, logs show the PostgreSQL service health check changed from `starting` to `healthy` and the job continued. The completed logs do not record an `Initialize containers` failure; the earlier apparent stall was a service-readiness wait, not a confirmed workflow or application defect. All workflow tests use test-only PostgreSQL and do not connect to production.

## Remaining blockers before production

1. Owner confirms Render runtime version, build/start commands, environment variables and actual proxy hop count.
2. Owner validates database schema/migration on a non-production copy, confirms least-privilege DB role, backup and restore procedure.
3. Owner performs a separate controlled deployment and validates TLS, cookies, admin login, rate limiting, headers and health checks in the real hosting topology.
4. Owner reviews Nexus credentials/permissions and upstream contract without exposing credentials.
5. Keep orders, payments, receipt uploads and fulfillment disabled until a separately scoped implementation and threat review has explicit approval, test coverage, refund/privacy/legal review and a safe staging test plan.
6. Conduct a human review of this PR and its full diff. CI success alone is not a merge/deploy authorization.

## Actions explicitly not performed

- No merge; PR remains open.
- No change directly to `main`.
- No production deployment or Render configuration change.
- No production database connection or destructive operation.
- No real orders, payments, receipt uploads, Nexus order requests or UC fulfillment.
- No production secrets/tokens/passwords were printed or copied into this report.
