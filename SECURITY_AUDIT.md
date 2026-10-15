# Security audit report — ZAVAEBATEL UC

**Reviewed branch:** `security/audit-safe-storefront`  
**Current branch head at report update:** `e640a8ef51ab994c460089c5a2ed8002637b9b45`  
**Last confirmed successful CI:** [GitHub Actions run #98](https://github.com/Beak67/zavaebatel-uc/actions/runs/38693525905), on earlier commit `25ba68a8e301f152487504ef5b1870d7ca36cd16`. The current head adds async route error forwarding and a regression test; a separate successful CI result for that newer code has not yet been confirmed.  
**Scope limitation:** this is a repository/code review plus CI evidence, not a production penetration test or a certification of production readiness.

## Executive summary

The current branch intentionally runs in a safe, non-transactional mode. Order creation, receipt upload, payment instructions, order-state changes, payment confirmation and UC fulfillment are disabled in code and return HTTP 503 (payment info explicitly says disabled). CI passed dependency installation, JavaScript syntax checks, tests and the production-dependency audit command. No production deployment, production database access/mutation, real payment, receipt upload, Nexus order or UC fulfillment was performed.

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
- `package-lock.json` is present with lockfile version 3. The latest CI run successfully executed `npm ci`.
- The workflow successfully ran `npm audit --omit=dev`. This checks production dependencies known to npm at run time; it does not prove that the entire application has no vulnerabilities, and it does not audit development dependencies.
- `.env.example` contains empty placeholders, not live credentials. No production environment variables were accessed.
- **Not verified:** independent secret scanning of all Git history, private Render configuration, token rotation status or dependencies against advisories published after the CI run.

## Verification evidence

Run #98: [https://github.com/Beak67/zavaebatel-uc/actions/runs/38693525905](https://github.com/Beak67/zavaebatel-uc/actions/runs/38693525905)

All workflow steps completed successfully:
1. `npm ci`
2. `node --check server.js && node --check public/admin.js && node --check public/storefront.js`
3. `npm test` (Node test runner; smoke tests and PostgreSQL-backed integration tests against an ephemeral PostgreSQL 16 service)
4. `npm audit --omit=dev`

The test workflow uses test-only PostgreSQL credentials and does not connect to production. Local execution was not needed for the above reported result; the result is from GitHub Actions.

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
