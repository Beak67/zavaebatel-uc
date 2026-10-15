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
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false }, connectionTimeoutMillis: 5000 }) : null;
const PgStore = connectPgSimple(session);
let dbError = null;

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: { directives: {
  defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'", 'data:', 'https:'], connectSrc: ["'self'"], objectSrc: ["'none'"],
  frameAncestors: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"]
} }, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: false, limit: '8kb' }));

if (pool && process.env.SESSION_SECRET?.length >= 32) {
  app.use(session({ name: 'zuc.sid', store: new PgStore({ pool, createTableIfMissing: true, tableName: 'user_sessions' }),
    secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false, rolling: true,
    cookie: { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', maxAge: 4 * 60 * 60 * 1000, path: '/' } }));
} else app.use((_req, _res, next) => { next(); });

const loginLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: true, legacyHeaders: false });
const orderLimit = rateLimit({ windowMs: 60 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });
const receiptLimit = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 1, parts: 2 },
  fileFilter: (_req, f, cb) => {
    const ext = path.extname(f.originalname || '').toLowerCase();
    const allowed = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.pdf': 'application/pdf' };
    cb(allowed[ext] === f.mimetype ? null : new Error('Разрешены JPG, PNG или PDF с корректным MIME-типом.'), allowed[ext] === f.mimetype);
  } });

async function initDb() {
  if (!pool) return;
  await pool.query(`
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
    ALTER TABLE manual_orders DROP CONSTRAINT IF EXISTS manual_orders_status_check;
    UPDATE manual_orders SET status=CASE status
      WHEN 'awaiting_payment' THEN 'pending_payment' WHEN 'proof_submitted' THEN 'receipt_submitted'
      WHEN 'payment_confirmed' THEN 'paid' WHEN 'payment_rejected' THEN 'rejected'
      WHEN 'ready_for_fulfillment' THEN 'paid' ELSE status END;
    ALTER TABLE manual_orders ADD CONSTRAINT manual_orders_status_check
      CHECK (status IN ('pending_payment','receipt_submitted','paid','rejected','fulfilled'));
    CREATE INDEX IF NOT EXISTS manual_orders_created_at_idx ON manual_orders(created_at DESC);
    CREATE TABLE IF NOT EXISTS admin_audit (
      id BIGSERIAL PRIMARY KEY, order_public_id UUID NOT NULL, action TEXT NOT NULL, result TEXT NOT NULL,
      admin_identity TEXT NOT NULL DEFAULT 'admin', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}
const dbReady = initDb().catch(e => { dbError = e; console.error('database_init_failed', { type: e.code || e.name || 'Error' }); });
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
function requireDb(_req,res,next) {
  if (!pool) return res.status(503).json({ error:'PostgreSQL не настроен: задайте DATABASE_URL.' });
  if (dbError) return res.status(503).json({ error:'PostgreSQL недоступен или схема не инициализирована.' });
  if (!process.env.ADMIN_PASSWORD || !process.env.SESSION_SECRET || process.env.SESSION_SECRET.length<32)
    return res.status(503).json({ error:'Администрирование отключено: задайте ADMIN_PASSWORD и SESSION_SECRET длиной не менее 32 символов.' });
  next();
}
function requireAdmin(req,res,next) { if (req.session?.isAdmin===true) return next(); return res.status(401).json({error:'Требуется вход администратора.'}); }
function requireCsrf(req,res,next) {
  if (!req.session?.csrfToken || !safeEqual(req.get('x-csrf-token')||'',req.session.csrfToken)) return res.status(403).json({error:'CSRF-проверка не пройдена.'});
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
app.get('/api/health', (_req,res)=>res.status(dbError?503:200).json({ok:!dbError,shop:'ZAVAEBATEL UC',database:!pool?'not_configured':dbError?'error':'configured',ordersEnabled:false}));
app.get('/api/catalog', async (_req,res)=>{
  try { const products=await getCatalog(); res.set('Cache-Control','no-store').json({mode:'live',currency:'RUB',count:products.length,products:products.map(p=>({id:p.id,name:p.name,icon:p.icon,price:retailPrice(p.priceUsd)}))}); }
  catch(e) { res.status(e.kind==='configuration'?503:502).json({error:e.message,code:e.kind||'catalog_unavailable'}); }
});
app.get('/api/payment-info', (_req,res)=>res.json({enabled:false,message:'Покупки и платёжные инструкции отключены. Не переводите деньги.'}));
app.post('/api/orders', orderLimit, (_req,res)=>res.status(503).json({error:'Создание заказов отключено до отдельной проверки платёжного процесса.'}));
app.get('/api/orders/:publicId', requireDb, async (req,res)=>{
  const secret=String(req.get('x-order-secret')||'');
  if (!validId(req.params.publicId)||secret.length<32) return res.status(404).json({error:'Заказ не найден.'});
  const r=await pool.query('SELECT public_id,product_name,amount_rub,status,created_at,receipt_uploaded_at FROM manual_orders WHERE public_id=$1 AND access_secret_hash=$2',[req.params.publicId,hash(secret)]);
  if (!r.rowCount) return res.status(404).json({error:'Заказ не найден.'});
  res.set('Cache-Control','no-store').json(r.rows[0]);
});
app.post('/api/orders/:publicId/receipt', receiptLimit, (_req,res)=>res.status(503).json({error:'Загрузка чеков отключена вместе с оформлением заказов.'}));
app.post('/api/admin/login', loginLimit, requireDb, (req,res)=>{
  if (!safeEqual(req.body?.password||'',process.env.ADMIN_PASSWORD||'')) return res.status(401).json({error:'Неверный пароль.'});
  req.session.regenerate(err=>{
    if(err||!req.session) return res.status(500).json({error:'Не удалось создать защищённую сессию.'});
    req.session.isAdmin=true; req.session.csrfToken=crypto.randomBytes(32).toString('hex');
    req.session.save(e=>e?res.status(500).json({error:'Не удалось сохранить сессию.'}):res.json({ok:true,csrfToken:req.session.csrfToken}));
  });
});
app.get('/api/admin/session',requireDb,requireAdmin,(req,res)=>res.set('Cache-Control','no-store').json({ok:true,csrfToken:req.session.csrfToken}));
app.get('/api/admin/orders',requireDb,requireAdmin,async (_req,res)=>{
  const r=await pool.query('SELECT public_id,product_name,product_id,player_id,amount_rub,status,admin_note,created_at,receipt_uploaded_at,reviewed_at,reviewed_by FROM manual_orders ORDER BY created_at DESC LIMIT 200');
  res.set('Cache-Control','no-store').json({orders:r.rows});
});
app.get('/api/admin/orders/:publicId/receipt',requireDb,requireAdmin,async(req,res)=>{
  if(!validId(req.params.publicId)) return res.sendStatus(404);
  const r=await pool.query('SELECT receipt_data,receipt_mime FROM manual_orders WHERE public_id=$1 AND receipt_data IS NOT NULL',[req.params.publicId]);
  if(!r.rowCount) return res.sendStatus(404);
  res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Disposition':'attachment; filename="receipt"'}).type(r.rows[0].receipt_mime).send(r.rows[0].receipt_data);
});
app.post('/api/admin/logout',requireDb,requireAdmin,requireCsrf,(req,res)=>req.session.destroy(e=>e?res.status(500).json({error:'Не удалось завершить сессию.'}):res.json({ok:true})));
app.post('/api/admin/orders/:publicId/:action',requireDb,requireAdmin,requireCsrf,async(req,res)=>{
  const transitions={confirm:['receipt_submitted','paid'],reject:['receipt_submitted','rejected'],fulfill:['paid','fulfilled']};
  const t=transitions[req.params.action], id=req.params.publicId;
  if(!validId(id)||!t) return res.status(400).json({error:'Некорректное действие.'});
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const r=await client.query('UPDATE manual_orders SET status=$1,admin_note=$2,reviewed_at=NOW(),reviewed_by=$3 WHERE public_id=$4 AND status=$5 RETURNING public_id,status',[t[1],typeof req.body?.note==='string'?req.body.note.slice(0,500):null,'admin',id,t[0]]);
    await client.query('INSERT INTO admin_audit(order_public_id,action,result) VALUES($1,$2,$3)',[id,req.params.action,r.rowCount?'success':'rejected_invalid_transition']);
    await client.query('COMMIT');
    if(!r.rowCount) return res.status(409).json({error:'Недопустимый переход статуса. Оплату подтверждайте только по поступлению в банковском приложении.'});
    res.json({ok:true,order:r.rows[0]});
  } catch(e) { await client.query('ROLLBACK').catch(()=>{}); console.error('admin_action_failed',{type:e.code||e.name||'Error'}); res.status(500).json({error:'Не удалось выполнить действие.'}); }
  finally { client.release(); }
});
app.use((req,res)=>req.path.startsWith('/api/')?res.status(404).json({error:'API endpoint не найден.'}):res.status(404).type('text').send('Not Found'));
app.use((err,_req,res,_next)=>{
  console.error('request_failed',{type:err.type==='entity.too.large'?'body_too_large':err.code||err.name||'Error'});
  if(!res.headersSent) res.status(err.type==='entity.too.large'?413:400).json({error:err.type==='entity.too.large'?'Тело запроса слишком большое.':'Некорректный запрос.'});
});
if (process.env.NODE_ENV !== 'test') app.listen(Number(process.env.PORT||3000),'0.0.0.0',()=>console.log('ZAVAEBATEL UC listening',{port:Number(process.env.PORT||3000)}));
export default app;
