# ZAVAEBATEL UC — безопасная ветка аудита

## Текущий режим безопасности

Приложение показывает каталог и рассчитанные сервером цены при доступности Nexus. **Реальные покупки и операции исполнения намеренно отключены в коде** независимо от значения `SBP_ENABLED`:

- `POST /api/orders` и `POST /api/orders/:publicId/receipt` возвращают HTTP 503.
- `GET /api/payment-info` всегда сообщает, что платежи отключены.
- Административные изменения статуса, подтверждение оплаты и выдача UC возвращают HTTP 503.
- Автоматическая отправка заказов в Nexus и выдача UC не выполняются.
- Статические файлы обслуживаются из `public/`; `/admin` — отдельная явно заданная страница `admin.html`. Корневые файлы вроде `server.js`, `package.json`, `.env` и README не доступны через static middleware.
- Helmet устанавливает security headers; CSP ограничивает скрипты `'self'`, а inline script не разрешён.
- SQL-запросы с пользовательскими значениями используют параметры PostgreSQL (`$1`, `$2`); динамический SQL из пользовательского ввода не используется.
- При отсутствии PostgreSQL/схемы/секретов административные API закрываются fail-closed; fallback на MemoryStore отсутствует.

## Сессии, CSRF и proxy

- Сессии хранятся в PostgreSQL через `connect-pg-simple`; `createTableIfMissing: false`.
- Cookie: `HttpOnly`, `SameSite=Strict`, `Secure` при `NODE_ENV=production`, срок действия 4 часа.
- Идентификатор сессии регенерируется после успешного входа; logout удаляет серверную сессию.
- Изменяющие административные запросы требуют CSRF-токен; login требует Origin, совпадающий с Host запроса.
- Login ограничен rate limit. Заказы и загрузка чеков дополнительно блокируются независимо от переменных окружения.
- `TRUST_PROXY_HOPS` должен соответствовать реальной топологии proxy. Значение `1` в `.env.example` — пример, не подтверждение Render-настройки. Неправильное число hops может повлиять на определение IP и secure cookies; перед production подтвердите topology.
- TLS для удалённого PostgreSQL настроен с `rejectUnauthorized: true`; `PGSSL_CA` может задавать CA.

## PostgreSQL и миграции

Миграция `migrations/001_session_store_and_safe_admin.sql` является аддитивной: создаёт отсутствующие таблицы/индексы и добавляет отсутствующую колонку `reviewed_by`. Она не удаляет таблицы и не переписывает статусы заказов. До применения на существующей БД сделайте резервную копию и проверьте миграцию на отдельной тестовой базе. Рекомендуется `DB_AUTO_INIT=false` после явного применения миграции.

## Проверки CI

[Run #131](https://github.com/Beak67/zavaebatel-uc/actions/runs/38695300547) успешно проверил branch HEAD `04c8b02ed20fd38385705558104f3f8723c64255`: `npm ci` — success; `node --check server.js && node --check public/admin.js && node --check public/storefront.js` — success; `npm test` — 17/17 passed; `npm audit --omit=dev` — success, 0 vulnerabilities в production dependencies. Регрессионный тест поднимает реальный Express test server, вызывает rejected async handler и проверяет HTTP-ответ Express error middleware. Smoke tests и интеграционный тест авторизованного администратора запускаются с `SBP_ENABLED=true`; тест подтверждает, что выдача UC всё равно возвращает HTTP 503.

Последующие изменения README и аудиторского отчёта — только документация; application code, тесты и `package-lock.json` не менялись. Run #114 сначала ждал health check тестового PostgreSQL (`starting` → `healthy`), после чего успешно завершился; ошибки на `Initialize containers` не зафиксировано. `package-lock.json` использует lockfile v3. CI не доказывает безопасность production или отсутствие всех возможных уязвимостей.

Подробности, покрытие и ограничения описаны в [SECURITY_AUDIT.md](SECURITY_AUDIT.md).

## Что не проверено / блокеры перед production

- Не проверялись Render Dashboard, Render environment variables, текущий deployment и TLS termination.
- Не подключались к production PostgreSQL; фактическая схема, права пользователя БД, резервные копии и восстановление не проверялись.
- Не проверялись реальные admin cookies/login на домене Render и фактическое количество доверенных proxy hops.
- Не вызывался Nexus API с реальными credentials; не подтверждались контракт поставщика, ограничения и production-цены.
- Не выполнялись реальные заказы, платежи, загрузка чеков, выдача UC или production deploy.
- Нужны отдельное ревью владельца, проверка конфигурации Render и согласованный тестовый план до любого production deployment.
- Покупки/платежи/receipt upload/fulfillment должны оставаться выключенными до отдельного проектирования, threat review, реализации и тестирования. Не включайте их изменением env-переменной.

## Render — только после отдельного согласования

Рекомендуемые команды: Build `npm ci`, Start `node server.js`, Node.js 20+. Задавайте private environment variables в Render Dashboard, не в GitHub. `DATABASE_URL`, `ADMIN_PASSWORD`, `SESSION_SECRET` и Nexus token не должны попадать в issue, коммиты или логи. `TRUST_PROXY_HOPS` задавайте только после подтверждения сетевой топологии. Автоматический deploy в рамках этого аудита не выполнялся.

## Откат

Эта работа не изменяет `main`, не выполняет merge, не запускает deploy и не изменяет production БД. Для отката после будущего согласованного deploy используйте штатный rollback хостинга, не переписывая историю Git.
