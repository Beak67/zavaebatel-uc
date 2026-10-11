```js
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const NEXUS_API_BASE = (
  process.env.NEXUS_API_BASE || 'https://nexus.amadeustech.dev'
).replace(/\/$/, '');

app.use(express.json({ limit: '100kb' }));

// Публикуем сайт из корневой папки проекта.
app.use(express.static(__dirname));

// Проверка работоспособности сервера.
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    shop: 'ZAVAEBATEL UC'
  });
});

// Получение каталога от поставщика Nexus.
app.get('/api/catalog', async (_req, res) => {
  const token = process.env.NEXUS_SHOP_TOKEN;

  if (!token) {
    return res.json({
      mode: 'demo',
      products: [],
      message:
        'Nexus API не подключён. Добавьте NEXUS_SHOP_TOKEN в переменные окружения сервера.'
    });
  }

  try {
    const response = await fetch(
      `${NEXUS_API_BASE}/api/v1/catalog`,
      {
        headers: {
          Authorization: `Shop ${token}`,
          Accept: 'application/json'
        },
        signal: AbortSignal.timeout(15000)
      }
    );

    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error('Nexus catalog error:', response.status);

      return res.status(502).json({
        error:
          'Не удалось загрузить каталог поставщика. Проверьте настройки Nexus.'
      });
    }

    return res.json({
      mode: 'live',
      catalog: body
    });
  } catch (err) {
    console.error('Nexus request failed:', err.message);

    return res.status(502).json({
      error: 'Сервер Nexus временно недоступен.'
    });
  }
});

// Заказы отключены до проверки товара, выдачи UC и оплаты.
app.post('/api/orders', (_req, res) => {
  return res.status(501).json({
    error:
      'Оформление заказов пока отключено. Сначала подтвердите товар PUBG UC в каталоге Nexus и настройте разрешённый способ оплаты.'
  });
});

// Показываем index.html для остальных адресов сайта.
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`ZAVAEBATEL UC server listening on ${PORT}`);
});
```
