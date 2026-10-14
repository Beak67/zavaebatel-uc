
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);

const NEXUS_API_BASE = (
  process.env.NEXUS_API_BASE || 'https://nexus.amadeustech.dev'
).trim().replace(/\/+$/, '');

app.use(express.json());
app.use(express.static(currentDir));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, shop: 'ZAVAEBATEL UC' });
});

app.get('/api/catalog', async (req, res) => {
  const shopId = process.env.NEXUS_SHOP_ID?.trim();
  const shopToken = process.env.NEXUS_SHOP_TOKEN?.trim();

  if (!shopId || !shopToken) {
    return res.status(503).json({
      error: 'Настройки Nexus отсутствуют в Render.'
    });
  }

  try {
    const url =
      `${NEXUS_API_BASE}/api/v1/products?categoryId=pubg-mobile%3Auc`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Shop ${shopId}:${shopToken}`,
        Accept: 'application/json'
      },
      signal: AbortSignal.timeout(20000)
    });

    const text = await response.text();
    let data;

    try {
      data = JSON.parse(text);
    } catch {
      console.error('Nexus вернул не JSON. HTTP:', response.status);
      return res.status(502).json({
        error: 'Поставщик вернул некорректный ответ.'
      });
    }

    if (!response.ok) {
      console.error('Nexus HTTP status:', response.status);
      return res.status(502).json({
        error: 'Не удалось получить каталог Nexus.',
        upstreamStatus: response.status
      });
    }

    let products = [];

    if (Array.isArray(data)) {
      products = data;
    } else if (Array.isArray(data.products)) {
      products = data.products;
    } else if (Array.isArray(data.data)) {
      products = data.data;
    } else if (Array.isArray(data.items)) {
      products = data.items;
    }

    // Оставляем только товары PUBG Mobile UC.
    products = products.filter((p) => {
      const id = String(p.id || '').toLowerCase();
      const name = String(p.name || p.title || '').toLowerCase();

      return id.startsWith('pubg-mobile:uc:') ||
        (name.includes('uc') && name.includes('pubg'));
    });

    return res.json({
      mode: 'live',
      count: products.length,
      products
    });
  } catch (error) {
    console.error('Nexus request error:', error.name, error.message);

    return res.status(502).json({
      error: 'Не удалось подключиться к Nexus.',
      reason: error.name || 'UnknownError'
    });
  }
});

// Реальные заказы пока отключены.
app.post('/api/orders', (req, res) => {
  res.status(501).json({
    error: 'Оформление заказов ещё не настроено.'
  });
});

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(currentDir, 'index.html'));
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'API route not found.' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`ZAVAEBATEL UC server listening on port ${PORT}`);
});
