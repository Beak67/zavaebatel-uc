import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import session from 'express-session';
import pg from 'pg';
import connectPgSimple from 'connect-pg-simple';
import helmet from 'helmet';
import multer from 'multer';
import rateLimit from 'express-rate-limit';

const { Pool } = pg;
const app = express();
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const NEXUS_API_BASE = (process.env.NEXUS_API_BASE || 'https://nexus.amadeustech.dev').trim().replace(/\/+$/, '');
const pool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
}) : null;
const PgSession = connectPgSimple(session);
const sbpEnabled = process.env.SBP_ENABLED === 'true';
const markup = Number(process.env.SALE_MARKUP ?? 0.20);
const usdRub = Number(process.env.NEXUS_USD_RUB ?? 85);

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '100kb' }));
app.use(express.static(currentDir, { index: false }));

if (pool && process.env.SESSION_SECRET) {
  app.use(session({
    store: new PgSession({ pool, createTableIfMissing: true, tableName: 'user_sessions' }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', maxAge: 8 * 60 * 60 * 1000 }
  }));
} else {
  // Admin endpoints remain unavailable if persistent secure session settings are missing.
  app.use(session({ secret: 'development-only-not-for-production', resave: false, saveUninitialized: false }));
}

const adminLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });
const orderLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 15, standardHeaders: true, legacyHeaders: false });
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (['image/jpeg', 'image/png', 'application/pdf'].includes(file.mimetype)) cb(null, true);
    else cb(new Error('Можно загрузить только JPG, PNG или PDF.'));
  }
});

async function initDb() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS manual_orders (
      id BIGSERIAL PRIMARY KEY,
      public_id UUID NOT NULL UNIQUE,
      access_secret_hash TEXT NOT NULL,
      product_id TEXT NOT NULL,
      product_name TEXT NOT NULL,
      player_id TEXT NOT NULL,
      amount_rub NUMERIC(12,2) NOT NULL,
      status TEXT NOT NULL DEFAULT 'awaiting_payment'
        CHECK (status IN ('awaiting_payment','proof_submitted','payment_confirmed','payment_rejected','ready_for_fulfillment')),
      receipt_data BYTEA,
      receipt_mime TEXT,
      receipt_uploaded_at TIMESTAMPTZ,
      admin_note TEXT,
      reviewed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS manual_orders_created_at_idx ON manual_orders(created_at DESC);
  `);
}
const ready = initDb().catch(err => { console.error('Database initialization failed:', err.message); });

async function getCatalog() {
  const shopId = process.env.NEXUS_SHOP_ID?.trim();
  const shopToken = process.env.NEXUS_SHOP_TOKEN?.trim();
  if (!shopId || !shopToken) throw new Error('Настройки Nexus отсутствуют в Render.');
  const response = await fetch(`${NEXUS_API_BASE}/api/v1/products?categoryId=pubg-mobile%3Auc`, {
    headers: { Authorization: `Shop ${shopId}:${shopToken}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(20000)
  });
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error('Поставщик вернул некорректный ответ.'); }
  if (!response.ok) throw new Error(`Ошибка каталога Nexus (${response.status}).`);
  let products = Array.isArray(data) ? data : data.products || data.data || data.items || [];
  return products.filter(p => {
    const id = String(p.id || '').toLowerCase();
    const name = String(p.name || p.title || '').toLowerCase();
    return id.startsWith('pubg-mobile:uc:') || (name.includes('uc') && name.includes('pubg'));
  }).map(p => ({
    id: String(p.id),
    name: String(p.name || p.title || p.id),
    icon: typeof p.icon === 'string' ? p.icon : null,
    priceUsd: Number(p.price)
  })).filter(p => Number.isFinite(p.priceUsd) && p.priceUsd > 0);
}
function priceRub(priceUsd) {
  if (process.env.NEXUS_PRICE_CURRENCY !== 'USD') throw new Error('В Render нужно подтвердить NEXUS_PRICE_CURRENCY=USD.');
  if (!Number.isFinite(markup) || markup < 0 || markup > 3 || !Number.isFinite(usdRub) || usdRub <= 0) throw new Error('Проверь настройки цены в Render.');
  return (Math.round(priceUsd * usdRub * (1 + markup) * 100) / 100).toFixed(2);
}
function hashSecret(secret) { return crypto.createHash('sha256').update(secret).digest('hex'); }
function safeEqual(a, b) {
  const aa = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function requireDb(req, res, next) {
  if (!pool) return res.status(503).json({ error: 'PostgreSQL не подключён в Render.' });
  if (!process.env.ADMIN_PASSWORD || !process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
    return res.status(503).json({ error: 'Не настроены безопасные параметры администратора.' });
  }
  next();
}
function requireAdmin(req, res, next) {
  if (req.session?.isAdmin === true) return next();
  return res.status(401).json({ error: 'Нужен вход администратора.' });
}
function validPublicId(s) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(s)); }

app.get('/api/health', (_req, res) => res.json({ ok: true, shop: 'ZAVAEBATEL UC' }));

app.get('/api/catalog', async (_req, res) => {
  try {
    const products = await getCatalog();
    res.json({
      mode: 'live',
      currency: 'RUB',
      count: products.length,
      products: products.map(p => ({
        id: p.id, name: p.name, icon: p.icon,
        price: Number(priceRub(p.priceUsd))
      }))
    });
  } catch (err) {
    console.error('Catalog error:', err.message);
    res.status(502).json({ error: err.message || 'Не удалось получить каталог.' });
  }
});

app.get('/api/payment-info', (_req, res) => {
  if (!sbpEnabled) return res.json({ enabled: false, message: 'Оплата пока отключена. Заказы не оплачивайте.' });
  const fields = ['SBP_PAYEE_NAME', 'SBP_BANK_NAME', 'SBP_PHONE'];
  if (fields.some(k => !process.env[k]?.trim())) return res.status(503).json({ enabled: false, message: 'Реквизиты СБП не настроены.' });
  res.json({
    enabled: true,
    payeeName: process.env.SBP_PAYEE_NAME,
    bankName: process.env.SBP_BANK_NAME,
    phone: process.env.SBP_PHONE,
    instructions: process.env.SBP_PAYMENT_INSTRUCTIONS || 'После перевода загрузите чек. Заказ будет проверен вручную.'
  });
});

app.post('/api/orders', orderLimiter, requireDb, async (req, res) => {
  try {
    await ready;
    const productId = String(req.body?.productId || '').trim();
    const playerId = String(req.body?.playerId || '').trim();
    if (!/^pubg-mobile:uc:\d+$/.test(productId)) return res.status(400).json({ error: 'Некорректный товар.' });
    if (!/^[A-Za-z0-9_-]{3,40}$/.test(playerId)) return res.status(400).json({ error: 'Проверь Player ID.' });
    if (!sbpEnabled) return res.status(503).json({ error: 'Приём заказов пока отключён. Не переводите деньги.' });
    const products = await getCatalog();
    const product = products.find(p => p.id === productId);
    if (!product) return res.status(400).json({ error: 'Товар не найден в каталоге Nexus.' });
    const amount = priceRub(product.priceUsd);
    const publicId = crypto.randomUUID();
    const accessSecret = crypto.randomBytes(24).toString('base64url');
    await pool.query(
      `INSERT INTO manual_orders(public_id,access_secret_hash,product_id,product_name,player_id,amount_rub)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [publicId, hashSecret(accessSecret), product.id, product.name, playerId, amount]
    );
    res.status(201).json({
      orderId: publicId, accessSecret, productName: product.name,
      amountRub: Number(amount), status: 'awaiting_payment',
      payment: {
        payeeName: process.env.SBP_PAYEE_NAME, bankName: process.env.SBP_BANK_NAME,
        phone: process.env.SBP_PHONE,
        instructions: process.env.SBP_PAYMENT_INSTRUCTIONS || 'Переведите точную сумму и загрузите чек.'
      }
    });
  } catch (err) {
    console.error('Create order error:', err.message);
    res.status(500).json({ error: 'Не удалось создать заказ.' });
  }
});

app.get('/api/orders/:publicId', requireDb, async (req, res) => {
  const { publicId } = req.params;
  const secret = String(req.headers['x-order-secret'] || '');
  if (!validPublicId(publicId) || secret.length < 20) return res.status(404).json({ error: 'Заказ не найден.' });
  const result = await pool.query(
    'SELECT public_id,product_name,amount_rub,status,created_at,receipt_uploaded_at FROM manual_orders WHERE public_id=$1 AND access_secret_hash=$2',
    [publicId, hashSecret(secret)]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Заказ не найден.' });
  res.json(result.rows[0]);
});

app.post('/api/orders/:publicId/receipt', orderLimiter, requireDb, (req, res) => {
  upload.single('receipt')(req, res, async err => {
    if (err) return res.status(400).json({ error: err.message || 'Не удалось загрузить чек.' });
    try {
      const { publicId } = req.params;
      const secret = String(req.headers['x-order-secret'] || '');
      if (!validPublicId(publicId) || secret.length < 20 || !req.file) return res.status(400).json({ error: 'Заказ или файл не распознан.' });
      const b = req.file.buffer;
      const mime = req.file.mimetype;
      const signatureOk =
        (mime === 'image/jpeg' && b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9) ||
        (mime === 'image/png' && b.length > 8 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) ||
        (mime === 'application/pdf' && b.subarray(0, 5).toString() === '%PDF-');
      if (!signatureOk) return res.status(400).json({ error: 'Формат файла не соответствует содержимому.' });
      const result = await pool.query(
        `UPDATE manual_orders SET receipt_data=$1,receipt_mime=$2,receipt_uploaded_at=NOW(),status='proof_submitted'
         WHERE public_id=$3 AND access_secret_hash=$4 AND status IN ('awaiting_payment','payment_rejected') RETURNING public_id`,
        [b, mime, publicId, hashSecret(secret)]
      );
      if (!result.rowCount) return res.status(404).json({ error: 'Заказ не найден или чек уже отправлен.' });
      res.json({ ok: true, status: 'proof_submitted', message: 'Чек отправлен на ручную проверку.' });
    } catch (e) {
      console.error('Receipt upload error:', e.message);
      res.status(500).json({ error: 'Не удалось сохранить чек.' });
    }
  });
});

app.post('/api/admin/login', adminLimiter, requireDb, (req, res) => {
  const password = String(req.body?.password || '');
  if (!process.env.ADMIN_PASSWORD || !safeEqual(password, process.env.ADMIN_PASSWORD)) {
    return res.status(401).json({ error: 'Неверный пароль.' });
  }
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'Не удалось создать сессию.' });
    req.session.isAdmin = true;
    req.session.save(e => e ? res.status(500).json({ error: 'Не удалось сохранить сессию.' }) : res.json({ ok: true }));
  });
});
app.post('/api/admin/logout', requireAdmin, (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/admin/orders', requireDb, requireAdmin, async (_req, res) => {
  const result = await pool.query(
    `SELECT public_id,product_name,product_id,player_id,amount_rub,status,admin_note,created_at,receipt_uploaded_at,reviewed_at
     FROM manual_orders ORDER BY created_at DESC LIMIT 200`
  );
  res.json({ orders: result.rows });
});
app.get('/api/admin/orders/:publicId/receipt', requireDb, requireAdmin, async (req, res) => {
  if (!validPublicId(req.params.publicId)) return res.sendStatus(404);
  const r = await pool.query('SELECT receipt_data,receipt_mime FROM manual_orders WHERE public_id=$1 AND receipt_data IS NOT NULL', [req.params.publicId]);
  if (!r.rowCount) return res.sendStatus(404);
  res.set('Cache-Control', 'no-store');
  res.type(r.rows[0].receipt_mime).send(r.rows[0].receipt_data);
});
app.post('/api/admin/orders/:publicId/:action', requireDb, requireAdmin, async (req, res) => {
  const { publicId, action } = req.params;
  if (!validPublicId(publicId)) return res.status(400).json({ error: 'Некорректный заказ.' });
  const actions = {
    confirm: { from: 'proof_submitted', to: 'payment_confirmed' },
    reject: { from: 'proof_submitted', to: 'payment_rejected' },
    ready: { from: 'payment_confirmed', to: 'ready_for_fulfillment' }
  };
  const transition = actions[action];
  if (!transition) return res.status(404).json({ error: 'Неизвестное действие.' });
  const note = String(req.body?.note || '').slice(0, 500);
  const r = await pool.query(
    `UPDATE manual_orders SET status=$1,admin_note=$2,reviewed_at=NOW()
     WHERE public_id=$3 AND status=$4 RETURNING public_id,status`,
    [transition.to, note || null, publicId, transition.from]
  );
  if (!r.rowCount) return res.status(409).json({ error: 'Статус изменился или действие недоступно.' });
  res.json({ ok: true, order: r.rows[0] });
});

app.get('/admin', (_req, res) => res.sendFile(path.join(currentDir, 'admin.html')));
app.use((err, _req, res, _next) => {
  console.error('Unhandled request error:', err.message);
  res.status(500).json({ error: 'Внутренняя ошибка сервера.' });
});
app.listen(PORT, '0.0.0.0', () => console.log(`ZAVAEBATEL UC server listening on port ${PORT}`));
