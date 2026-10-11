import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const NEXUS_API_BASE = (process.env.NEXUS_API_BASE || 'https://nexus.amadeustech.dev').replace(/\/$/, '');

// Webhooks that require signature verification must use express.raw() on their route
// before express.json(). This starter intentionally does not accept unverified webhooks.
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (_req, res) => res.json({ ok: true, shop: 'ZAVAEBATEL UC' }));

app.get('/api/catalog', async (_req, res) => {
  const token = process.env.NEXUS_SHOP_TOKEN;
  if (!token) {
    return res.json({ mode: 'demo', products: [], message: 'Nexus API не подключён. Добавьте NEXUS_SHOP_TOKEN в переменные окружения сервера.' });
  }
  try {
    const response = await fetch(`${NEXUS_API_BASE}/api/v1/catalog`, {
      headers: { Authorization: `Shop ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error('Nexus catalog error:', response.status);
      return res.status(502).json({ error: 'Не удалось загрузить каталог поставщика. Проверьте настройки Nexus.' });
    }
    // Send provider catalog through for inspection; UI renders only verified PUBG UC items.
    res.json({ mode: 'live', catalog: body });
  } catch (err) {
    console.error('Nexus request failed:', err.message);
    res.status(502).json({ error: 'Сервер Nexus временно недоступен.' });
  }
});

// Orders and payments are intentionally not enabled until the exact PUBG UC product,
// required deliveryData fields, permitted payment flow, and pricing are verified.
app.post('/api/orders', (_req, res) => {
  res.status(501).json({ error: 'Оформление заказа пока отключено: сначала подтвердите товар PUBG UC в каталоге Nexus и настройте разрешённый способ оплаты.' });
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log(`ZAVAEBATEL UC server listening on ${PORT}`));
