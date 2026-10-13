import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);

const NEXUS_API_BASE = (
process.env.NEXUS_API_BASE || 'https://nexus.amadeustech.dev'
).replace(//$/, '');

app.use(express.json({ limit: '100kb' }));
app.use(express.static(__dirname));

app.get('/api/health', (_req, res) => {
res.json({
ok: true,
shop: 'ZAVAEBATEL UC'
});
});

app.get('/api/catalog', async (_req, res) => {
const token = process.env.NEXUS_SHOP_TOKEN;

if (!token) {
return res.json({
mode: 'demo',
products: [],
message: 'Nexus API пока не подключён.'
});
}

try {
const catalogUrl =
NEXUS_API_BASE + '/api/v1/catalog';

```
const response = await fetch(catalogUrl, {
  headers: {
    Authorization: 'Shop ' + token,
    Accept: 'application/json'
  },
  signal: AbortSignal.timeout(15000)
});

const body = await response.json().catch(() => ({}));

if (!response.ok) {
  console.error('Nexus catalog error:', response.status);

  return res.status(502).json({
    error: 'Не удалось загрузить каталог Nexus.'
  });
}

return res.json({
  mode: 'live',
  catalog: body
});
```

} catch (error) {
console.error('Nexus request failed:', error.message);

```
return res.status(502).json({
  error: 'Сервер Nexus временно недоступен.'
});
```

}
});

app.post('/api/orders', (_req, res) => {
res.status(501).json({
error: 'Заказы пока отключены до проверки каталога PUBG UC и настройки оплаты.'
});
});

app.get('*', (_req, res) => {
res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
console.log('ZAVAEBATEL UC server listening on port ' + PORT);
});
