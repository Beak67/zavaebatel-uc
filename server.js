import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);

const rawNexusUrl =
process.env.NEXUS_API_BASE || 'https://nexus.amadeustech.dev';

const NEXUS_API_BASE = rawNexusUrl.replace(//+$/, '');

app.use(express.json());
app.use(express.static(currentDir));

app.get('/api/health', function (req, res) {
res.status(200).json({
ok: true,
shop: 'ZAVAEBATEL UC'
});
});

app.get('/api/catalog', async function (req, res) {
const shopToken = process.env.NEXUS_SHOP_TOKEN;

if (!shopToken) {
return res.status(503).json({
error: 'Не настроен NEXUS_SHOP_TOKEN в Render.'
});
}

try {
const url =
NEXUS_API_BASE +
'/api/v1/products?categoryId=pubg-mobile%3Auc';

```
const response = await fetch(url, {
  method: 'GET',
  headers: {
    Authorization: 'Shop ' + shopToken,
    Accept: 'application/json'
  },
  signal: AbortSignal.timeout(15000)
});

const responseText = await response.text();

let body;

try {
  body = JSON.parse(responseText);
} catch {
  console.error(
    'Nexus returned non-JSON response. HTTP:',
    response.status
  );

  return res.status(502).json({
    error: 'Nexus вернул ответ не в формате JSON.',
    upstreamStatus: response.status
  });
}

if (!response.ok) {
  console.error(
    'Nexus catalog HTTP status:',
    response.status,
    body.errorCode || 'unknown'
  );

  return res.status(502).json({
    error: 'Nexus не смог выдать каталог.',
    upstreamStatus: response.status,
    details: body.errorCode || body.errorMessage || 'Unknown error'
  });
}

if (!Array.isArray(body)) {
  console.error('Unexpected Nexus products response format');

  return res.status(502).json({
    error: 'Неожиданный формат каталога Nexus.'
  });
}

return res.json({
  mode: 'live',
  products: body
});
```

} catch (error) {
console.error(
'Nexus request failed:',
error && error.message ? error.message : String(error)
);

```
return res.status(502).json({
  error: 'Не удалось подключиться к Nexus.'
});
```

}
});

app.post('/api/orders', function (req, res) {
return res.status(501).json({
error: 'Оформление заказов пока не подключено.'
});
});

app.get('*', function (req, res) {
res.sendFile(path.join(currentDir, 'index.html'));
});

app.listen(PORT, '0.0.0.0', function () {
console.log(
'ZAVAEBATEL UC server listening on port ' + PORT
);
});
