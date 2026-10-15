import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import session from 'express-session';
import pg from 'pg';
import connectPgSimple from 'connect-pg-simple';
import helmet from 'helmet';
import multer from 'multer';
import rateLimit from 'express-rate-limit';

const { Pool } = pg;
const app = express();
const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const sbpEnabled = process.env.SBP_ENABLED === 'true';
const base = (process.env.NEXUS_API_BASE || 'https://nexus.amadeustech.dev').trim().replace(/\/+$/, '');
const currency = process.env.NEXUS_PRICE_CURRENCY;
const fx = Number(process.env.NEXUS_USD_RUB ?? 85);
const markup = Number(process.env.SALE_MARKUP ?? 0.20);
const databaseUrl = process.env.DATABASE_URL || '';
const parsedDatabaseUrl = (() => { try { return new URL(databaseUrl); } catch { return null; } })();
const dbHost = parsedDatabaseUrl?.hostname.toLowerCase() || '';
const localDb = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(dbHost);
// pg-connection-string SSL query parameters can override the explicit ssl object; strip them so remote TLS verification stays enabled.
if (parsedDatabaseUrl) {
  for (const key of ['sslmode', 'ssl', 'sslcert', 'sslkey', 'sslrootcert']) parsedDatabaseUrl.searchParams.delete(key);
}
const dbConnectionString = parsedDatabaseUrl?.toString() || databaseUrl;
const pool = databaseUrl ? new Pool({
  connectionString: dbConnectionString,
  ssl: localDb ? false : { rejectUnauthorized: true, ...(process.env.PGSSL_CA ? { ca: process.env.PGSSL_CA } : {}) },
  connectionTimeoutMillis: 5000
}) : null;
const PgStore = connectPgSimple(session);
let dbError = null;

app.disable('x-powered-by');
// Trust forwarded client IPs only when the deployment explicitly declares its trusted proxy hop count.
const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS || 0);
if (Number.isInteger(trustProxyHops) && trustProxyHops >= 1 && trustProxyHops <= 5) app.set('trust proxy', trustProxyHops);
app.use(helmet({ contentSecurityPolicy: { directives: {
  defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'", 'data:', 'https:'], connectSrc: ["'self'"], objectSrc: ["'none'"],
  frameAncestors: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"]
} }, crossOriginEmbedderPolicy: false }));
app.use((req, res, next) => {
  req.requestId = crypto.randomUUID();
  res.setHeader('X-Request-ID', req.requestId);
  next();
});
app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: false, limit: '8kb' }));

const sessionConfigured = Boolean(pool && process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32);
if (sessionConfigured) {
  // Never fall back to express-session MemoryStore. The session table is provisioned by the explicit schema initializer/migration.
  app.use(session({ name: 'zuc.sid', store: new PgStore({ pool, createTableIfMissing: false, tableName: 'user_sessions' }),
    secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false, rolling: false,
    cookie: { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', maxAge: 4 * 60 * 60 * 1000, path: '/' } }));
} else app.use((_req, _res, next) => { next(); });

export class PostgresRateLimitStore {
  constructor({ pool, limiterName }) {
    this.pool = pool;
    this.limiterName = limiterName;
    this.windowMs = 60_000;
    this.operations = 0;
  }
  init(options) { this.windowMs = options.windowMs; }
  async increment(key) {
    if (!this.pool) {
      const error = new Error('Shared rate-limit storage is not configured');
      error.code = 'RATE_LIMIT_STORE_UNAVAILABLE';
      error.status = 503;
      throw error;
    }
    const keyHash = crypto.createHash('sha256').update(String(key)).digest('hex');
    try {
      const result = await this.pool.query(`
        INSERT INTO rate_limit_counters (limiter_name, key_hash, hits, reset_at)
        VALUES ($1, $2, 1, NOW() + ($3::bigint * INTERVAL '1 millisecond'))
        ON CONFLICT (limiter_name, key_hash) DO UPDATE SET
          hits = CASE WHEN rate_limit_counters.reset_at <= NOW() THEN 1 ELSE rate_limit_counters.hits + 1 END,
          reset_at = CASE WHEN rate_limit_counters.reset_at <= NOW()
            THEN NOW() + ($3::bigint * INTERVAL '1 millisecond') ELSE rate_limit_counters.reset_at END
        RETURNING hits, reset_at
      `, [this.limiterName, keyHash, this.windowMs]);
      this.operations++;
      // Opportunistic bounded cleanup; counters themselves remain PostgreSQL-backed and atomic.
      if (this.operations % 100 === 0) {
        await this.pool.query('DELETE FROM rate_limit_counters WHERE reset_at < NOW() - INTERVAL \'24 hours\'');
      }
      return { totalHits: Number(result.rows[0].hits), resetTime: new Date(result.rows[0].reset_at) };
    } catch {
      const error = new Error('Shared rate-limit storage is unavailable');
      error.code = 'RATE_LIMIT_STORE_UNAVAILABLE';
      error.status = 503;
      throw error;
    }
  }
  async decrement(key) {
    if (!this.pool) return;
    const keyHash = crypto.createHash('sha256').update(String(key)).digest('hex');
    await this.pool.query('UPDATE rate_limit_counters SET hits = GREATEST(hits - 1, 0) WHERE limiter_name = $1 AND key_hash = $2',
      [this.limiterName, keyHash]);
  }
  async resetKey(key) {
    if (!this.pool) return;
    const keyHash = crypto.createHash('sha256').update(String(key)).digest('hex');
    await this.pool.query('DELETE FROM rate_limit_counters WHERE limiter_name = $1 AND key_hash = $2',
      [this.limiterName, keyHash]);
  }
  async resetAll() {
    if (!this.pool) return;
    await this.pool.query('DELETE FROM rate_limit_counters WHERE limiter_name = $1', [this.limiterName]);
  }
}
const loginLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: true, legacyHeaders: false,
  store: new PostgresRateLimitStore({ pool, limiterName: 'admin-login' }) });
const orderLimit = rateLimit({ windowMs: 60 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false,
  store: new PostgresRateLimitStore({ pool, limiterName: 'order-create' }) });
const receiptLimit = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false,
  store: new PostgresRateLimitStore({ pool, limiterName: 'receipt-upload' }) });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 1, parts: 2 },
  fileFilter: (_req, f, cb) => {
    const ext = path.extname(f.originalname || '').toLowerCase();
    const allowed = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.pdf': 'application/pdf' };
    if (allowed[ext] !== f.mimetype) {
      const error = new Error('Разрешены JPG, PNG или PDF с корректным MIME-типом.');
      error.status = 400;
      return cb(error);
    }
    cb(null, true);
  } });

async function initDb() {
  if (!pool) return;
  // Opt-in only. This initializer creates missing tables/additive columns; it never rewrites existing order statuses.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_sessions (
      sid VARCHAR NOT NULL PRIMARY KEY,
      sess JSON NOT NULL,
      expire TIMESTAMP(6) NOT NULL
    );
    CREATE INDEX IF NOT EXISTS IDX_user_sessions_expire ON user_sessions(expire);
    CREATE TABLE IF NOT EXISTS manual_orders (
      id BIGSERIAL PRIMARY KEY, public_id UUID NOT NULL UNIQUE, access_secret_hash TEXT NOT NULL,
      product_id TEXT NOT NULL, product_name TEXT NOT NULL, player_id TEXT NOT NULL,
      amount_rub NUMERIC(12,2) NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending_payment',
      receipt_data BYTEA, receipt_mime TEXT, receipt_uploaded_at TIMESTAMPTZ,
      admin_note TEXT, reviewed_at TIMESTAMPTZ, reviewed_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE manual_orders ADD COLUMN IF NOT EXISTS reviewed_by TEXT;
    CREATE INDEX IF NOT EXISTS manual_orders_created_at_idx ON manual_orders(created_at DESC);
    CREATE TABLE IF NOT EXISTS admin_audit (
      id BIGSERIAL PRIMARY KEY, order_public_id UUID, action TEXT NOT NULL, operation_type TEXT NOT NULL, result TEXT NOT NULL,
      admin_identity TEXT NOT NULL DEFAULT 'anonymous', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      request_id UUID, reason_code TEXT, target_type TEXT, target_id TEXT, session_hash TEXT
    );
    ALTER TABLE admin_audit ALTER COLUMN order_public_id DROP NOT NULL;
    ALTER TABLE admin_audit ADD COLUMN IF NOT EXISTS operation_type TEXT;
    UPDATE admin_audit SET operation_type = action WHERE operation_type IS NULL;
    ALTER TABLE admin_audit ALTER COLUMN operation_type SET NOT NULL;
    ALTER TABLE admin_audit ADD COLUMN IF NOT EXISTS request_id UUID;
    ALTER TABLE admin_audit ADD COLUMN IF NOT EXISTS reason_code TEXT;
    ALTER TABLE admin_audit ADD COLUMN IF NOT EXISTS target_type TEXT;
    ALTER TABLE admin_audit ADD COLUMN IF NOT EXISTS target_id TEXT;
    ALTER TABLE admin_audit ADD COLUMN IF NOT EXISTS session_hash TEXT;
    CREATE TABLE IF NOT EXISTS rate_limit_counters (
      limiter_name TEXT NOT NULL, key_hash TEXT NOT NULL, hits INTEGER NOT NULL CHECK (hits >= 0),
      reset_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (limiter_name, key_hash)
    );
    CREATE INDEX IF NOT EXISTS rate_limit_counters_reset_at_idx ON rate_limit_counters(reset_at);
  `);
}
const requiredDbColumns = {
  user_sessions: ['sid', 'sess', 'expire'],
  manual_orders: ['public_id', 'access_secret_hash', 'product_id', 'product_name', 'player_id',
    'amount_rub', 'status', 'receipt_data', 'receipt_mime', 'receipt_uploaded_at', 'admin_note',
    'reviewed_at', 'reviewed_by', 'created_at'],
  admin_audit: ['order_public_id', 'action', 'operation_type', 'result', 'admin_identity', 'created_at',
    'request_id', 'reason_code', 'target_type', 'target_id', 'session_hash'],
  rate_limit_counters: ['limiter_name', 'key_hash', 'hits', 'reset_at']
};
export function missingRequiredSchemaColumns(rows) {
  const present = new Map();
  for (const row of rows) {
    if (!present.has(row.table_name)) present.set(row.table_name, new Set());
    present.get(row.table_name).add(row.column_name);
  }
  return Object.entries(requiredDbColumns).flatMap(([table, columns]) =>
    columns.filter(column => !present.get(table)?.has(column)).map(column => table + '.' + column));
}
export function hasSharedRateLimitUniqueKey(row) {
  return row?.has_shared_rate_limit_key === true;
}
async function verifyDbSchema() {
  // A table-only check can report ready for a stale schema and defer failure to a live request.
  const result = await pool.query(
    'SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = ANY($2::text[])',
    ['public', Object.keys(requiredDbColumns)]
  );
  if (missingRequiredSchemaColumns(result.rows).length) {
    throw Object.assign(new Error('Required database schema is missing or incompatible'), { code: 'DB_SCHEMA_MISSING' });
  }
  // ON CONFLICT requires a real unique/primary key on the exact pair; columns alone are insufficient.
  const constraint = await pool.query(`
    SELECT EXISTS (
      SELECT 1
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      WHERE c.conrelid = 'public.rate_limit_counters'::regclass
        AND c.contype IN ('p','u')
        AND (
          SELECT array_agg(a.attname::text ORDER BY k.ordinality)
          FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ordinality)
          JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
        ) = ARRAY['limiter_name','key_hash']::text[]
    ) AS has_shared_rate_limit_key
  `);
  if (!hasSharedRateLimitUniqueKey(constraint.rows[0])) {
    throw Object.assign(new Error('Shared rate-limit counter key is missing a compatible unique constraint'), { code: 'DB_SCHEMA_MISSING' });
  }
}
const dbReady = !pool
  ? Promise.resolve()
  : (process.env.DB_AUTO_INIT === 'true' ? initDb() : verifyDbSchema())
      .catch(e => { dbError = e; console.error('database_init_failed', { type: e.code || e.name || 'Error' }); });
function safeEqual(a,b) { const x=Buffer.from(String(a)); const y=Buffer.from(String(b)); return x.length===y.length && crypto.timingSafeEqual(x,y); }
function hash(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function validId(s) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(s)); }
function priceError() {
  if (currency !== 'USD') return 'Конфигурация Nexus: явно установите NEXUS_PRICE_CURRENCY=USD.';
  if (!Number.isFinite(fx) || fx <= 0 || !Number.isFinite(markup) || markup < 0 || markup > 3) return 'Проверьте NEXUS_USD_RUB и SALE_MARKUP.';
  if (!process.env.NEXUS_SHOP_ID?.trim() || !process.env.NEXUS_SHOP_TOKEN?.trim()) return 'Не настроены NEXUS_SHOP_ID и NEXUS_SHOP_TOKEN в Render.';
  return null;
}
export function retailPrice(usd) {
  if (currency !== 'USD') throw new Error('NEXUS_PRICE_CURRENCY должен быть явно установлен в USD.');
  if (!Number.isFinite(fx) || fx <= 0 || !Number.isFinite(markup) || markup < 0 || markup > 3) throw new Error('Некорректная конфигурация цены.');
  if (!Number.isFinite(usd) || usd <= 0) throw new Error('Некорректная цена поставщика.');
  return Math.round(usd * fx * (1 + markup) * 100) / 100;
}
export function normalizeProducts(data) {
  const list = Array.isArray(data) ? data : [data?.products, data?.data, data?.items].find(Array.isArray);
  if (!Array.isArray(list)) throw new Error('Ответ Nexus не содержит распознаваемого списка товаров.');
  return list.filter(p => p && typeof p === 'object' && typeof p.id === 'string' && /^pubg-mobile:uc:\d+$/.test(p.id))
    .map(p => {
      if (!['number','string'].includes(typeof p.price) || String(p.price).trim() === '') throw new Error('У товара Nexus отсутствует поле price.');
      const priceUsd = Number(p.price);
      if (!Number.isFinite(priceUsd) || priceUsd <= 0) throw new Error('Nexus вернул некорректную цену.');
      return { id: p.id, name: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : p.id,
        icon: typeof p.icon === 'string' && /^https:\/\//i.test(p.icon) ? p.icon : null, priceUsd };
    });
}
export async function getCatalog() {
  const config = priceError();
  if (config) throw Object.assign(new Error(config), { kind: 'configuration' });
  const started = Date.now();
  let last;
  for (let attempt=1; attempt<=2; attempt++) {
    let response;
    try {
      response = await fetch(`${base}/api/v1/products?categoryId=pubg-mobile%3Auc`, {
        headers: { Authorization: `Shop ${process.env.NEXUS_SHOP_ID.trim()}:${process.env.NEXUS_SHOP_TOKEN.trim()}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(8000)
      });
      if (!response.ok) {
        console.warn('nexus_request', { durationMs: Date.now()-started, status: response.status, errorType: 'http', attempt });
        if (attempt===1 && [429,502,503,504].includes(response.status)) { await response.body?.cancel().catch(()=>{}); await new Promise(r=>setTimeout(r,200)); continue; }
        throw Object.assign(new Error(`Nexus ответил HTTP ${response.status}.`), { kind: 'upstream_http' });
      }
      let body;
      try { body=JSON.parse(await response.text()); } catch { throw Object.assign(new Error('Nexus вернул некорректный JSON.'), { kind: 'upstream_json' }); }
      const products=normalizeProducts(body);
      console.info('nexus_request', { durationMs: Date.now()-started, status: response.status, errorType: null, count: products.length });
      return products;
    } catch(e) {
      last=e;
      console.warn('nexus_request', { durationMs: Date.now()-started, status: response?.status ?? null, errorType: e.kind || e.name || 'Error', attempt });
      const temporary = ['TimeoutError','AbortError','TypeError'].includes(e.name);
      if (attempt===1 && temporary) { await new Promise(r=>setTimeout(r,200)); continue; }
      break;
    }
  }
  if (last?.kind) throw last;
  throw Object.assign(new Error('Nexus временно недоступен. Попробуйте позже.'), { kind: 'upstream_unavailable' });
}
async function requireDb(req,res,next) {
  await dbReady;
  const deny = async (reasonCode, message) => {
    if (req.path.startsWith('/api/admin/') && pool && !dbError) {
      try { await writeAudit(req,{action:'admin_prerequisite_check',result:'denied',reasonCode}); }
      catch { return res.status(503).json({error:'Журнал аудита недоступен; административный доступ запрещён.'}); }
    }
    return res.status(503).json({error:message});
  };
  if (!pool) return res.status(503).json({ error:'PostgreSQL не настроен: задайте DATABASE_URL.' });
  if (process.env.NODE_ENV === 'production' && !(Number.isInteger(trustProxyHops) && trustProxyHops >= 1 && trustProxyHops <= 5))
    return deny('proxy_configuration_invalid','Администрирование отключено: задайте TRUST_PROXY_HOPS согласно доверенной proxy-топологии Render.');
  if (!sessionConfigured) return deny('session_configuration_invalid','Администрирование отключено: задайте DATABASE_URL и SESSION_SECRET длиной не менее 32 символов.');
  if (dbError) return res.status(503).json({ error:'PostgreSQL недоступен или схема не инициализирована.' });
  if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 20)
    return deny('admin_credential_configuration_invalid','Администрирование отключено: задайте ADMIN_PASSWORD длиной не менее 20 символов.');
  next();
}
async function writeAudit(req, { action, operationType = action, result, reasonCode = null, targetType = null, targetId = null }) {
  if (!pool) throw Object.assign(new Error('Audit storage unavailable'), { code: 'AUDIT_STORE_UNAVAILABLE' });
  const validTargetId = typeof targetId === 'string' && validId(targetId) ? targetId : null;
  const sessionHash = req.sessionID ? hash(req.sessionID) : null;
  await pool.query(`
    INSERT INTO admin_audit
      (order_public_id, action, operation_type, result, admin_identity, request_id, reason_code, target_type, target_id, session_hash)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
  `, [validTargetId, action, operationType, result, req.session?.isAdmin === true ? 'admin' : 'anonymous',
    req.requestId || crypto.randomUUID(), reasonCode, targetType, validTargetId, sessionHash]);
}
async function auditDenied(req, res, { action, reasonCode, status, error }) {
  try { await writeAudit(req, { action, result: 'denied', reasonCode }); }
  catch { return res.status(503).json({ error: 'Операция отклонена; журнал аудита недоступен.' }); }
  return res.status(status).json({ error });
}
async function requireAdmin(req,res,next) {
  if (req.session?.isAdmin===true) return next();
  try { await writeAudit(req, { action: 'admin_access', result: 'denied', reasonCode: 'authentication_required' }); }
  catch { return res.status(503).json({ error:'Журнал аудита недоступен; доступ запрещён.' }); }
  return res.status(401).json({error:'Требуется вход администратора.'});
}
async function requireSameOrigin(req,res,next) {
  const origin = req.get('origin');
  let parsed;
  try { parsed = origin ? new URL(origin) : null; } catch { parsed = null; }
  if (!parsed || parsed.host !== req.get('host') || !['http:', 'https:'].includes(parsed.protocol))
    return auditDenied(req,res,{action:'admin_origin_check',reasonCode:origin?'origin_mismatch':'origin_missing',status:403,error:origin?'Origin не разрешён.':'Origin обязателен для входа администратора.'});
  next();
}
export const asyncHandler = fn => (req,res,next) => Promise.resolve(fn(req,res,next)).catch(next);
async function requireCsrf(req,res,next) {
  if (!req.session?.csrfToken || !safeEqual(req.get('x-csrf-token')||'',req.session.csrfToken))
    return auditDenied(req,res,{action:'admin_csrf_check',reasonCode:'csrf_invalid',status:403,error:'CSRF-проверка не пройдена.'});
  next();
}

app.get('/', (_req,res,next)=> {
  const file=path.join(publicDir,'index.html');
  if (!existsSync(file)) return res.status(404).type('text').send('Storefront not found');
  res.sendFile(file, err=>{ if(err && !res.headersSent) next(err); });
});
app.get('/admin', (_req,res,next)=> {
  const file=path.join(root,'admin.html');
  if (!existsSync(file)) return res.status(404).type('text').send('Admin page not found');
  res.sendFile(file, err=>{ if(err && !res.headersSent) next(err); });
});
// Only the dedicated public directory is exposed; project files and secrets remain outside the static root.
app.use(express.static(publicDir, { index:false, dotfiles:'deny', fallthrough:true, maxAge:0 }));
app.get('/api/health', asyncHandler(async (_req,res)=> {
  await dbReady;
  const database = !pool ? 'not_configured' : dbError ? 'error' : 'configured';
  const ok = Boolean(pool) && !dbError;
  res.status(ok ? 200 : 503).json({ ok, shop:'ZAVAEBATEL UC', database, ordersEnabled:false });
}));
app.get('/api/catalog', asyncHandler(async (_req,res)=>{
  try { const products=await getCatalog(); res.set('Cache-Control','no-store').json({mode:'live',currency:'RUB',count:products.length,products:products.map(p=>({id:p.id,name:p.name,icon:p.icon,price:retailPrice(p.priceUsd)}))}); }
  catch(e) { res.status(e.kind==='configuration'?503:502).json({error:e.message,code:e.kind||'catalog_unavailable'}); }
}));
app.get('/api/payment-info', (_req,res)=>res.json({enabled:false,message:'Покупки и платёжные инструкции отключены. Не переводите деньги.'}));
app.post('/api/orders', orderLimit, (_req,res)=>res.status(503).json({error:'Создание заказов отключено до отдельной проверки платёжного процесса.'}));
app.get('/api/orders/:publicId', requireDb, asyncHandler(async (req,res)=>{
  const secret=String(req.get('x-order-secret')||'');
  if (!validId(req.params.publicId)||secret.length<32) return res.status(404).json({error:'Заказ не найден.'});
  const r=await pool.query('SELECT public_id,product_name,amount_rub,status,created_at,receipt_uploaded_at FROM manual_orders WHERE public_id=$1 AND access_secret_hash=$2',[req.params.publicId,hash(secret)]);
  if (!r.rowCount) return res.status(404).json({error:'Заказ не найден.'});
  res.set('Cache-Control','no-store').json(r.rows[0]);
}));
app.post('/api/orders/:publicId/receipt', receiptLimit, (_req,res)=>res.status(503).json({error:'Загрузка чеков отключена вместе с оформлением заказов.'}));
app.post('/api/admin/login', loginLimit, requireSameOrigin, requireDb, asyncHandler(async (req,res)=>{
  if (!safeEqual(req.body?.password||'',process.env.ADMIN_PASSWORD||'')) {
    try { await writeAudit(req, { action:'admin_login', result:'denied', reasonCode:'invalid_credentials' }); }
    catch { return res.status(503).json({error:'Журнал аудита недоступен; вход запрещён.'}); }
    return res.status(401).json({error:'Неверный пароль.'});
  }
  await new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
  if (!req.session) {
    await writeAudit(req, { action:'admin_login', result:'error', reasonCode:'session_regeneration_failed' });
    return res.status(500).json({error:'Не удалось создать защищённую сессию.'});
  }
  req.session.isAdmin=true; req.session.csrfToken=crypto.randomBytes(32).toString('hex');
  try {
    await new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
    await writeAudit(req, { action:'admin_login', result:'success' });
  } catch {
    await new Promise(resolve => req.session.destroy(() => resolve())).catch(()=>{});
    return res.status(503).json({error:'Не удалось сохранить сессию или запись аудита.'});
  }
  return res.json({ok:true,csrfToken:req.session.csrfToken});
}));
app.get('/api/admin/session',requireDb,requireAdmin,asyncHandler(async (req,res)=>{
  await writeAudit(req,{action:'admin_session_view',result:'success'});
  res.set('Cache-Control','no-store').json({ok:true,csrfToken:req.session.csrfToken});
}));
app.get('/api/admin/orders',requireDb,requireAdmin,asyncHandler(async (req,res)=>{
  const r=await pool.query('SELECT public_id,product_name,product_id,player_id,amount_rub,status,admin_note,created_at,receipt_uploaded_at,reviewed_at,reviewed_by FROM manual_orders ORDER BY created_at DESC LIMIT 200');
  await writeAudit(req,{action:'admin_orders_view',result:'success'});
  res.set('Cache-Control','no-store').json({orders:r.rows});
}));
app.get('/api/admin/orders/:publicId/receipt',requireDb,requireAdmin,asyncHandler(async(req,res)=>{
  if(!validId(req.params.publicId)) {
    await writeAudit(req,{action:'admin_receipt_view',result:'denied',reasonCode:'invalid_target_id'});
    return res.sendStatus(404);
  }
  const r=await pool.query('SELECT receipt_data,receipt_mime FROM manual_orders WHERE public_id=$1 AND receipt_data IS NOT NULL',[req.params.publicId]);
  if(!r.rowCount) {
    await writeAudit(req,{action:'admin_receipt_view',result:'denied',reasonCode:'receipt_not_found',targetType:'order',targetId:req.params.publicId});
    return res.sendStatus(404);
  }
  await writeAudit(req,{action:'admin_receipt_view',result:'success',targetType:'order',targetId:req.params.publicId});
  res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Disposition':'attachment; filename="receipt"'}).type(r.rows[0].receipt_mime).send(r.rows[0].receipt_data);
}));
app.post('/api/admin/logout',requireDb,requireAdmin,requireCsrf,asyncHandler(async(req,res)=> {
  try { await writeAudit(req,{action:'admin_logout',result:'success'}); }
  catch { return res.status(503).json({error:'Журнал аудита недоступен; выход не подтверждён.'}); }
  await new Promise((resolve,reject)=>req.session.destroy(error=>error?reject(error):resolve()));
  res.clearCookie('zuc.sid',{httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'strict',path:'/'});
  return res.json({ok:true});
}));
app.post('/api/admin/orders/:publicId/:action',requireDb,requireAdmin,requireCsrf,asyncHandler(async(req,res)=>{
  const knownAction = new Set(['fulfill','approve-payment','mark-paid','cancel','complete']);
  await writeAudit(req,{action:'admin_order_action',operationType:knownAction.has(req.params.action)?req.params.action:'unknown_action',
    result:'denied',reasonCode:'safe_mode_disabled',targetType:'order',targetId:validId(req.params.publicId)?req.params.publicId:null});
  return res.status(503).json({error:'Изменение заказов, подтверждение платежей и выдача UC отключены в безопасном режиме.'});
}));
app.use((req,res)=>req.path.startsWith('/api/')?res.status(404).json({error:'API endpoint не найден.'}):res.status(404).type('text').send('Not Found'));
app.use((err,req,res,_next)=>{
  const type = err.type==='entity.too.large' ? 'body_too_large' : (typeof err.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(err.code) ? err.code : 'request_error');
  console.error('request_failed',{type,requestId:req.requestId||null});
  const storageUnavailable = err.code === 'RATE_LIMIT_STORE_UNAVAILABLE' || err.code === 'AUDIT_STORE_UNAVAILABLE'
    || (typeof err.code === 'string' && /^(08|53|57P01|3D000|42P01|ECONN|ETIMEDOUT|EHOSTUNREACH|ENOTFOUND)/.test(err.code));
  const tooLarge = err.type === 'entity.too.large';
  const badRequest = err.type === 'entity.parse.failed' || err.status === 400 || (typeof err.code === 'string' && err.code.startsWith('LIMIT_'));
  const status = tooLarge ? 413 : storageUnavailable ? 503 : badRequest ? 400 : 500;
  const message = status===413 ? 'Тело запроса слишком большое.'
    : status===503 ? 'Хранилище лимитов, аудита или база данных временно недоступны.'
    : status===400 ? 'Некорректный запрос.'
    : 'Внутренняя ошибка сервера.';
  const respond = () => { if(!res.headersSent) res.status(status).json({error:message}); };
  if (req.path.startsWith('/api/admin/') && pool) {
    writeAudit(req,{action:'admin_request_error',result:'error',reasonCode:storageUnavailable?'storage_unavailable':badRequest?'invalid_request':'internal_error'})
      .then(respond,respond);
  } else respond();
});
if (process.env.NODE_ENV !== 'test') app.listen(Number(process.env.PORT||3000),'0.0.0.0',()=>console.log('ZAVAEBATEL UC listening',{port:Number(process.env.PORT||3000)}));
export default app;
