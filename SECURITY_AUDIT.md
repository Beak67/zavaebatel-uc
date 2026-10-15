# Production-readiness / security audit — ZAVAEBATEL UC

**Scope:** repository review and safe CI tests on `security/audit-safe-storefront`. No production deployment, production configuration change, production database connection, real order/payment/receipt upload, or UC fulfillment was performed.

**Tested application/test revision:** `dcdec4de4959a2834a0aa7e1aa07aa64bb873371`  
**CI evidence:** [Run #179](https://github.com/Beak67/zavaebatel-uc/actions/runs/38697844156) passed on the latest documentation-updated branch head; it ran `npm ci`, syntax checks, `npm test` (20 passed, 0 failed, 0 skipped), and `npm audit --omit=dev` (0 production dependency vulnerabilities reported). The tested application/test revision is `dcdec4de4959a2834a0aa7e1aa07aa64bb873371`; commits after it only changed documentation.

## Decision

**NOT PRODUCTION-READY. Do not merge/deploy on the basis of CI alone. Keep orders, payment instructions, receipt uploads, payment confirmation and UC fulfillment disabled.** The repository tests support the safe-mode behavior; critical facts about Render, production PostgreSQL, backups/restores and Nexus credentials/contract remain unverified.

Status definitions: **PASS** means supported by the named code review/test/evidence; **FAIL** means a concrete issue is present; **NOT VERIFIED** means external access, a production-like isolated environment or additional evidence is required. PASS does not certify production.

## 1. Render, HTTPS, proxy and sessions

| Status | Check and evidence |
|---|---|
| PASS | `server.js`: Express trusts forwarded headers only when `TRUST_PROXY_HOPS` parses as an integer from 1 through 5; production admin routes fail closed if it is absent/invalid. This is a guard, not proof that the configured hop count is correct. |
| PASS | `server.js`: session cookie uses `HttpOnly`, `SameSite=Strict`, `Secure` when `NODE_ENV=production`, path `/`, four-hour `maxAge`, and no rolling refresh. Login regenerates the session ID and saves the new session. `tests/session.integration.test.js` checks cookie attributes, login and logout against the test PostgreSQL service. |
| PASS | Login is rate-limited (8 attempts per 15 minutes by the configured rate limiter); order and receipt endpoints also have limits. Login requires an Origin matching the request Host; admin mutation routes require a session CSRF token. Evidence: `server.js`, authenticated integration test. |
| PASS | Security headers/CSP are configured with Helmet in `server.js`; `tests/smoke.test.js` checks CSP script restrictions and that project files outside `public/` are not served as static assets. |
| NOT VERIFIED | Render's actual proxy chain, TLS termination, domain/custom-domain settings, runtime Node version, build/start commands, environment-variable presence and whether the live service runs this branch. Verify in Render Dashboard before any deployment. Do not infer these values from `.env.example`. |
| NOT VERIFIED | Real-browser cookie behavior and rate-limit client-IP attribution through the actual Render proxy chain. `express-rate-limit` uses its default per-process store here; if multiple instances are used, limits are not a shared global counter. Confirm instance topology or adopt a shared store before relying on a global attempt limit. |
| NOT VERIFIED | Canonical production-origin policy. Code compares Origin's host to the incoming Host; it does not pin a separately configured canonical origin. Confirm the deployed host/proxy behavior and consider an explicit canonical-origin allowlist if the topology warrants it. |
| NOT VERIFIED | Admin credential lifecycle, recovery, rotation procedure and MFA. Current code uses a single configured admin password; CI does not verify production account operations or MFA. |

## 2. PostgreSQL, schema and migrations

| Status | Check and evidence |
|---|---|
| PASS | Request-controlled identifiers in reviewed queries use PostgreSQL parameters (`$1`, `$2`) and order UUIDs are validated before lookup. Evidence: `server.js`. |
| PASS | Remote PostgreSQL connections enable certificate verification (`rejectUnauthorized: true`); connection query parameters that could override SSL settings are stripped before constructing the pool. Evidence: `server.js`. This does not verify the real production connection configuration or CA chain. |
| PASS | `migrations/001_session_store_and_safe_admin.sql` uses a transaction, `IF NOT EXISTS` table/index creation and additive `ADD COLUMN IF NOT EXISTS`; it does not drop/truncate tables or rewrite order statuses. The test `PostgreSQL migration is executable and idempotent on the isolated test database` runs it twice against CI PostgreSQL 16 and checks the expected tables/indexes. |
| PASS | Schema readiness now checks required columns via `information_schema.columns`, not only table names. `tests/smoke.test.js` tests complete, missing-column and missing-schema cases using the extracted validator; the PostgreSQL integration test also provisions and exercises the expected schema. |
| PASS | `DB_AUTO_INIT` defaults to the verification path; initialization is opt-in. Session store table auto-creation by `connect-pg-simple` is disabled. Evidence: `server.js`, `.env.example`. |
| NOT VERIFIED | Production schema, existing data compatibility, constraints/indexes on the real database, migration scheduling/ownership, connection pool sizing and the privileges actually granted to the production database role. No production DB connection or migration was attempted. |
| NOT VERIFIED | Least-privilege grants. The repository does not establish what privileges the configured Render database role has; confirm using an approved read-only privilege review or a cloned environment. |
| NOT VERIFIED | Backup and restore. No accessible backup, restore target or restore evidence was provided; no restore is claimed. |
| NOT VERIFIED | SQL injection resistance is supported by inspection of reviewed parameterized queries, not by a dedicated adversarial penetration test. Keep parameterization mandatory for future queries. |

### Backup/restore drill — safe plan, not yet performed

1. In the hosting/database control plane, identify the configured backup source, retention policy, latest successful backup timestamp and point-in-time recovery window (if offered). Record metadata only; do not copy credentials or customer data into the audit.
2. Obtain explicit owner approval and a backup artifact/snapshot intended for testing. Provision a **new isolated PostgreSQL instance/database**, separate credentials and network access; do not reuse the production URL.
3. Before restore, validate the target endpoint and database name against an allowlist and ensure the restore job cannot resolve to production. Restore only into the isolated target.
4. Run schema checks and read-only invariants: expected tables/columns/indexes, row counts by non-sensitive categories, uniqueness of public order IDs, status values and timestamps. Compare with source backup metadata; avoid printing personal/player identifiers, receipts or secrets.
5. Capture duration, errors, schema/version, backup age and the validation outcome. Destroy or retain the restored copy according to the approved data-retention policy.
6. A real recovery requires owner approval, a declared recovery point, an incident/change ticket, an explicit target confirmation and a rollback/communications plan. No production restore, overwrite or failover should be inferred from this drill.

**Current restore status: NOT VERIFIED** — no backup artifact, isolated restore target or successful restore log was available during this audit.

## 3. Nexus, catalog and pricing

| Status | Check and evidence |
|---|---|
| PASS | The server obtains catalog data server-side; client-supplied prices are not used to create an order because order creation is disabled. Product IDs are restricted to the `pubg-mobile:uc:<digits>` shape, and supplier prices must be finite and positive before server-side retail calculation. Evidence: `normalizeProducts`, `retailPrice` in `server.js`, mock-based tests in `tests/smoke.test.js`. |
| PASS | Nexus requests have an eight-second timeout, bounded retry behavior and generic handling of network/upstream failures. Logs record timing/status/error type/count, not the Authorization header. Tests stub `fetch` and check malformed responses, HTTP errors and retry bounds. |
| PASS | Current fulfillment endpoint is a server-side HTTP 503 guard for every administrative action, including an authenticated admin with `SBP_ENABLED=true`. No fulfillment request was sent to Nexus. |
| NOT VERIFIED | Actual Nexus API contract, authentication scheme, token scope/permissions, sandbox availability, upstream idempotency semantics, price currency, live price accuracy, supplier SKU mapping and operational rate limits. No real Nexus credentials were used. |
| NOT VERIFIED | Protection against duplicate fulfillment for a future enabled implementation. It is not exercised because fulfillment is deliberately disabled; before any enablement, require server-side idempotency keys/order state transitions, retry/reconciliation semantics and tests against a confirmed sandbox. |
| NOT VERIFIED | Commercial price correctness. Formula and input validation are unit-tested, but FX value, markup, supplier currency and product mapping require owner-approved business rules and independent price reconciliation. |

Secrets are not intentionally returned by catalog/API handlers or embedded in client assets; the tests check known test markers and client responses. This is not a complete scan of Git history or private Render configuration. Secret-history scanning and credential rotation status remain **NOT VERIFIED**.

## 4. Safe-mode enforcement

**PASS — current routes remain disabled server-side even with `SBP_ENABLED=true`.**

Evidence:
- `tests/smoke.test.js`: sets `SBP_ENABLED=true`; checks order creation and receipt upload return HTTP 503, payment info remains disabled, the health route does not report an unconfigured database as healthy, and API responses do not expose known test credentials.
- `tests/session.integration.test.js`: runs with `SBP_ENABLED=true`; checks authenticated admin actions (`fulfill`, payment/status-like actions) return HTTP 503, payment instructions remain disabled, order creation/receipt upload remain blocked, CSRF checks work and logout invalidates the session.
- `server.js`: routes return 503 before any order/payment/receipt/fulfillment side effect; there is no live fulfillment implementation in these paths.

The test DB guard in `tests/session.integration.test.js` rejects non-loopback hosts and database names not ending in `_test` **before spawning the integration server**. CI uses a local ephemeral PostgreSQL 16 service. This is an accidental-misconfiguration guard, not a defense against a deliberately configured local tunnel to production; do not use tunnels or production connection strings for tests.

## 5. Findings by priority

### High — blocks production approval

1. **NOT VERIFIED — Render topology and HTTPS.** Confirm the real proxy hop count, TLS termination, forwarded protocol behavior, service settings and live code revision in Render. Evidence currently available: repository code and CI only.
2. **NOT VERIFIED — Production DB access model and recovery.** Confirm least-privilege grants, schema compatibility, backup freshness, restore process and a successful isolated restore before deployment.
3. **NOT VERIFIED — Nexus contract, permissions and prices.** Obtain owner-approved sandbox/test credentials and documented API/price semantics. Do not use production credentials for this audit.
4. **PASS — Current fulfillment stays disabled; NOT VERIFIED — future fulfillment safety.** There is no demonstrated idempotency/reconciliation path for a future enabled implementation; do not enable business operations until a separately reviewed design and sandbox tests exist.

### Medium — resolve or explicitly accept before launch

1. **NOT VERIFIED — Admin authentication policy.** The code uses one configured admin password and has no demonstrated MFA/recovery process. Owner must validate credential rotation, recovery and access policy; add individual admin identities/MFA if required by the threat model.
2. **FAIL — Rate limiting is process-local.** The configured default store does not provide a shared global counter across multiple instances. If Render runs more than one instance, use a shared store or explicitly accept this limitation after confirming topology.
3. **FAIL — Admin audit trail is incomplete.** The `admin_audit` table is provisioned, but rejected safe-mode operations are not written to an append-only audit trail. Do not treat this table as an operational audit system.
4. **NOT VERIFIED — Canonical origin policy.** Origin validation compares against the incoming Host rather than a separately configured canonical origin. Validate actual public-host/proxy behavior and consider an explicit allowlist.

No critical defect was found that enables real transactions in the current code paths; that is not equivalent to a clean bill of health for production.
## 6. Changed files in this audit

- `server.js` — schema readiness validates required columns and fails closed for incompatible schemas.
- `tests/smoke.test.js` — tests complete/missing-column schema validation.
- `tests/session.integration.test.js` — refuses non-loopback/non-`_test` DB targets; tests safe-mode admin actions with `SBP_ENABLED=true`; executes the SQL migration twice on isolated CI PostgreSQL.
- `SECURITY_AUDIT.md` — this evidence-based status report.
- `README.md`, `README_RU.md` — current test evidence and external blockers.

No changes to `main`, no merge, no deployment, no production environment changes, no production DB access/mutation and no real business operations were performed.

## 7. Tests and actual results

**CI run #169:** [https://github.com/Beak67/zavaebatel-uc/actions/runs/38697515235](https://github.com/Beak67/zavaebatel-uc/actions/runs/38697515235) — completed successfully on tested code/test revision `dcdec4de4959a2834a0aa7e1aa07aa64bb873371`.

| Command | Actual result |
|---|---|
| `npm ci` | PASS |
| `node --check server.js && node --check public/admin.js && node --check public/storefront.js` | PASS |
| `npm test` | PASS — 20 tests, 20 passed, 0 failed, 0 skipped |
| `npm audit --omit=dev` | PASS — 0 vulnerabilities reported in production dependencies |

These commands ran in GitHub Actions, not in a local environment. The dependency audit covers production dependencies known to npm at that run; it does not prove the application is vulnerability-free or audit all development dependencies.

## 8. External checks required before merge/deployment

- [ ] Render owner confirms the service settings, actual proxy topology, TLS/domain configuration and current deployed revision.
- [ ] Owner confirms production environment variable presence/quality in the dashboard without sharing secret values; verify the database URL is private and secrets are rotated/stored correctly.
- [ ] DBA confirms production schema compatibility and least-privilege role grants using a safe read-only review.
- [ ] Owner/DBA identifies a real backup and completes an isolated restore/invariant check.
- [ ] Nexus owner confirms sandbox, API contract, credential scope, SKU mapping, price currency and price reconciliation.
- [ ] Security/operations owner accepts the admin authentication, rate-limit and audit-trail design.
- [ ] Separate design/threat review and sandbox testing are completed before any order/payment/receipt/fulfillment code is enabled.
- [ ] Re-run CI on the final PR head and obtain human review before considering merge.

Until these checks are evidenced, the release decision remains **NOT PRODUCTION-READY**.