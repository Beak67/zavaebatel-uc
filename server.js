```javascript
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);

const NEXUS_API_BASE = (
  process.env.NEXUS_API_BASE ||
  'https://nexus.amadeustech.dev'
).replace(/\/+$/, '');

app.use(express.json());
app.use(express.static(currentDir));

app.get('/api/health', (req, res) => {
  res.status(200).json({
    ok: true,
    shop: 'ZAVAEBATEL UC'
  });
});

app.get('/api/catalog', async (req, res) => {
  const shopId = process.env.NEXUS_SHOP_ID;
  const shopToken = process.env.NEXUS_SHOP_TOKEN;

  if (!shopId || !shopToken) {
    return res.status(503).json({
      error: 'Добавь NEXUS_SHOP_ID и NEXUS_SHOP_TOKEN в Render Environment.'
    });
  }

  try {
    const response = await fetch(
      `${NEXUS_API_BASE}/api/v1/products?categoryId=pubg-mobile%3Auc`,
      {
        method: 'GET',
        headers: {
          Authorization: `Shop ${shopId}:${shopToken}`,
          Accept: 'application/json'
        },
        signal: AbortSignal.timeout(15000)
      }
    );

    const responseText = await response.text();
    let data;

    try {
      data = JSON.parse(responseText);
    } catch {
      console.error('Nexus returned non-JSON. HTTP:', response.status);
      return res.status(502).json({
        error: 'Nexus вернул ответ не в формате JSON.',
        upstreamStatus: response.status
      });
    }

    if (!response.ok) {
      console.error('Nexus catalog error:', response.status);
      return res.status(502).json({
        error: 'Nexus не смог выдать каталог.',
        upstreamStatus: response.status
      });
    }

    const products = Array.isArray(data)
      ? data
      : Array.isArray(data.products)
        ? data.products
        : Array.isArray(data.data)
          ? data.data
          : null;

    if (!products) {
      console.error('Unexpected Nexus catalog response format');
      return res.status(502).json({
        error: 'Формат каталога Nexus отличается от ожидаемого.'
      });
    }

    return res.json({
      mode: 'live',
      products
    });
  } catch (error) {
    console.error('Nexus request failed:', error.message);
    return res.status(502).json({
      error: 'Не удалось подключиться к Nexus.'
    });
  }
});

app.post('/api/orders', (req, res) => {
  res.status(501).json({
    error: 'Оформление заказов пока не подключено.'
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(currentDir, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`ZAVAEBATEL UC server listening on port ${PORT}`);
});
```
