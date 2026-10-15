# ZAVAEBATEL UC — безопасная ветка аудита

## Production-аудит Render

Задеплоенный commit `ed70726037e2f9cc4a332aa8738157278e93d561` был проверен отдельно от этой ветки. В production-коде был fallback на `express-session` MemoryStore с фиксированным development-секретом, отсутствовала CSRF-проверка административных POST-маршрутов, а `express.static(currentDir)` публиковал файлы из корня проекта. В той версии маршруты создания заказов и загрузки чеков могли активироваться через `SBP_ENABLED=true`.

Исправления ниже находятся в `security/audit-safe-storefront`; они не попадают в Render до отдельного согласованного изменения deployment.

## Режим безопасности

- `POST /api/orders` и `POST /api/orders/:id/receipt` всегда возвращают HTTP 503.
- `GET /api/payment-info` всегда сообщает, что платежи отключены.
- Административные действия изменения статуса, подтверждения платежа и выдачи UC также возвращают HTTP 503.
- Сервер не создаёт заказы у Nexus и не выдаёт UC автоматически.
- Статические файлы обслуживаются только из `public/`; корневые файлы проекта не публикуются.
- CSP включает `script-src 'self'`; Helmet устанавливает защитные заголовки.
- Секреты, пароли и cookie не должны попадать в репозиторий или логи.

## Сессии и PostgreSQL

- В production нет fallback на `MemoryStore`. Если PostgreSQL или `SESSION_SECRET` не настроены, административная функциональность закрывается с HTTP 503.
- Сессии хранятся в PostgreSQL через `connect-pg-simple`; `createTableIfMissing: false`, поэтому session store не создаёт таблицу скрытно.
- Cookie: `HttpOnly`, `Secure` при `NODE_ENV=production`, `SameSite=Strict`, путь `/`, фиксированный срок действия 4 часа с момента входа (без продления при активности).
- При входе идентификатор сессии регенерируется; пароль сравнивается constant-time; logout уничтожает серверную сессию и очищает cookie.
- CSRF-токен обязателен для административных изменяющих запросов. Для login обязателен Origin, который должен совпадать с Host запроса.
- Rate limits действуют на login, создание заказа и загрузку чека. Последние два маршрута дополнительно заблокированы независимо от переменных окружения.
- Ошибки хранилища возвращают безопасный ответ 503; логируются только тип/код ошибки, не connection string, токены, cookie или пользовательские данные.
- `TRUST_PROXY_HOPS` задаёт количество доверенных reverse-proxy hops. Для Render обычно требуется `1`, но подтвердите топологию сервиса перед настройкой. В production административные маршруты возвращают HTTP 503, если эта настройка отсутствует или некорректна.
- TLS-сертификат удалённой PostgreSQL проверяется (`rejectUnauthorized: true`). `PGSSL_CA` можно задать, если нужен дополнительный CA.

## PostgreSQL schema и миграция

Миграция `migrations/001_session_store_and_safe_admin.sql` создаёт отсутствующие таблицы `user_sessions`, `manual_orders`, `admin_audit`, индекс и добавляет только отсутствующую колонку `reviewed_by`. Она не удаляет таблицы и не переписывает статусы заказов. Перед запуском на любой существующей БД сделайте резервную копию и проверьте SQL на отдельной тестовой базе.

Рекомендуемый порядок:
1. Создайте PostgreSQL в Render.
2. В Render Database используйте Query/SQL-инструмент либо подключённый безопасный клиент, чтобы применить миграцию к нужной БД. Не публикуйте Internal Database URL.
3. Убедитесь, что миграция прошла успешно, а существующие строки и статусы не изменились.
4. В Web Service установите `DB_AUTO_INIT=false`. При старте приложение проверяет наличие требуемых таблиц, но не изменяет схему.
5. Если вы намеренно используете `DB_AUTO_INIT=true`, код выполняет только `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS` и `ADD COLUMN IF NOT EXISTS`; всё равно предпочтительна явная миграция с проверкой результата.

## Обязательные переменные Render

Задавайте значения в Render → Web Service → Environment как private environment variables. Не копируйте реальные значения в GitHub, README или логи.

- `NODE_ENV=production`
- `DATABASE_URL` — Internal Database URL для PostgreSQL Render; подключение должно быть доступно сервису.
- `ADMIN_PASSWORD` — уникальный длинный пароль, минимум 20 символов.
- `SESSION_SECRET` — криптографически случайная строка минимум 32 символа; не переиспользуйте пароль администратора.
- `DB_AUTO_INIT=false` после ручного применения миграции.
- `TRUST_PROXY_HOPS=1` только если сервис находится за одним доверенным proxy hop (типичный Render web service).
- `NEXUS_API_BASE`, `NEXUS_SHOP_ID`, `NEXUS_SHOP_TOKEN`, `NEXUS_PRICE_CURRENCY=USD`, `NEXUS_USD_RUB`, `SALE_MARKUP` — нужны только для чтения каталога и расчёта отображаемой цены; реальные credentials не включайте в тесты.
- `PGSSL_CA` — необязательный CA для PostgreSQL, если требуется вашей конфигурации.

Секрет сессии можно сгенерировать локально командой `openssl rand -hex 32`; вывод команды не добавляйте в репозиторий или issue. Убедитесь, что пароль администратора и session secret не пусты и не совпадают.

## Render configuration

В репозитории нет `render.yaml`. Проверяйте параметры непосредственно в Render Dashboard:

- Build command: `npm ci`
- Start command: `node server.js`
- Runtime: Node.js 20+
- `NODE_ENV=production`
- переменные окружения из списка выше
- Persistent PostgreSQL instance, доступный по Internal Database URL
- автоматический production deploy не запускать в рамках этого аудита.

После отдельного согласованного deploy проверьте `GET /api/health`: при доступной БД и правильной схеме ожидается HTTP 200; при отсутствии БД/таблиц — HTTP 503. Health check не доказывает, что реальная админ-сессия работает; для этого нужна отдельная проверка через тестовую БД.

## Проверки и ограничения

Workflow `.github/workflows/test.yml` запускает `npm ci`, `npm test` и `npm audit --omit=dev` в Node.js 20. Интеграционные тесты сессий используют только эфемерный PostgreSQL с тестовыми credentials в CI; они не обращаются к Render, Nexus или реальным платежам.

Фактический успешный run для commit `7c6960773b8687b10d6c5c0fdd2f42b2280eff9f`: [GitHub Actions run #90](https://github.com/Beak67/zavaebatel-uc/actions/runs/38692361446).
- `npm ci`: успешно; 99 packages added, 100 audited.
- `npm test`: **16 passed, 0 failed, 0 skipped**. Включены реальные HTTP-тесты login/session/CSRF/logout на эфемерной PostgreSQL и fail-closed тест при недоступном хранилище.
- `npm audit --omit=dev`: успешно; **0 vulnerabilities**.

Эти результаты относятся к проверенному коду и тестам; последний последующий commit, меняющий только этот README, также проходит стандартный CI отдельно. Не запускайте тесты против production DATABASE_URL.

## Что осталось непроверенным

- Render Environment и фактическая конфигурация сервиса не читались напрямую; проверить настройки Dashboard вручную.
- Не подключались к production PostgreSQL и не проверялись реальные credentials.
- Не проверялись реальные login/session cookies на домене Render, TLS termination и количество proxy hops.
- Nexus API не вызывался; контракт поставщика и реальные токены не проверялись.
- Не выполнялись реальные заказы, платежи, загрузка чеков или выдача UC.
- Успешные CI и npm audit не доказывают безопасность всего production-приложения.

## Откат

Эта работа не выполняет deploy, не меняет `main` и не сливает PR. После отдельного согласованного deploy откатывайтесь штатным rollback Render к предыдущему успешному deploy; не переписывайте историю Git.
