import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);

let NEXUS_API_BASE =
process.env.NEXUS_API_BASE || 'https://nexus.amadeustech.dev';

while (NEXUS_API_BASE.endsWith('/')) {
NEXUS_API_BASE = NEXUS_API_BASE.slice(0, -1);
}

app.use(express.json());
app.use(express.static(currentDir));

app.get('/api/health', function (req, res) {
return res.status(200).json({
ok: true,
shop: 'ZAVAEBATEL UC'
});
});

app.get('/api/catalog', async function (req, res) {
const shopId = process.env.NEXUS_SHOP_ID;
const shopToken = process.env.NEXUS_SHOP_TOKEN;

if (!shopId || !shopToken) {
return res.status(503).json({
error: 'Add NEXUS_SHOP_ID and NEXUS_SHOP_TOKEN in Render Environment.'
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
    Authorization: 'Shop ' + shopId + ':' + shopToken,
    Accept: 'application/json'
  },
  signal: AbortSignal.timeout(15000)
});

const responseText = await response.text();
let data;

try {
  data = JSON.parse(responseText);
} catch (error) {
  console.error('Nexus returned invalid JSON:', response.status);
  return res.status(502).json({
    error: 'Nexus returned invalid JSON.',
    upstreamStatus: response.status
  });
}

if (!response.ok) {
  console.error('Nexus catalog error:', response.status);
  return res.status(502).json({
    error: 'Nexus catalog request failed.',
    upstreamStatus: response.status
  });
}

let products = null;

if (Array.isArray(data)) {
  products = data;
} else if (data && Array.isArray(data.products)) {
  products = data.products;
} else if (data && Array.isArray(data.data)) {
  products = data.data;
}

if (!products) {
  console.error('Unexpected Nexus catalog response format');
  return res.status(502).json({
    error: 'Unexpected catalog format from Nexus.'
  });
}

return res.status(200).json({
  mode: 'live',
  products: products
});
```

} catch (error) {
console.error('Nexus request failed:', error.message);
return res.status(502).json({
error: 'Could not connect to Nexus.'
});
}
});

app.post('/api/orders', function (req, res) {
return res.status(501).json({
error: 'Order processing is not configured yet.'
});
});

app.use(function (req, res, next) {
if (req.path.startsWith('/api/')) {
return next();
}

return res.sendFile(path.join(currentDir, 'index.html'));
});

app.use('/api', function (req, res) {
return res.status(404).json({
error: 'API route not found.'
});
});

app.listen(PORT, '0.0.0.0', function () {
console.log('ZAVAEBATEL UC server listening on port ' + PORT);
});
