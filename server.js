import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);

const rawNexusUrl =
process.env.NEXUS_API_BASE || 'https://nexus.amadeustech.dev';

const NEXUS_API_BASE = rawNexusUrl.endsWith('/')
? rawNexusUrl.slice(0, -1)
: rawNexusUrl;

app.use(express.json());
app.use(express.static(currentDir));

app.get('/api/health', function (req, res) {
res.status(200).json({
ok: true,
shop: 'ZAVAEBATEL UC'
});
});

app.get('/api/catalog', async function (req, res) {
const token = process.env.NEXUS_SHOP_TOKEN;

if (!token) {
return res.json({
mode: 'demo',
products: [],
message: 'Nexus API пока не подключён.'
});
}

try {
const catalogUrl = NEXUS_API_BASE + '/api/v1/catalog';

```
const response = await fetch(catalogUrl, {
  method: 'GET',
  headers: {
    Authorization: 'Shop ' + token,
    Accept: 'application/json'
  },
  signal: AbortSignal.timeout(15000)
});

const body = await response.json().catch(function () {
  return {};
});

if (!response.ok) {
  console.error('Nexus catalog HTTP status:', response.status);

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

app.post('/api/orders', function (req, res) {
return res.status(501).json({
error: 'Заказы отключены до проверки каталога и настройки оплаты.'
});
});

app.get('*', function (req, res) {
res.sendFile(path.join(currentDir, 'index.html'));
});

app.listen(PORT, function () {
console.log('ZAVAEBATEL UC server listening on port ' + PORT);
});
