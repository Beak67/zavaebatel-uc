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
- Проверка готовности БД проверяет наличие обязательных столбцов, а не только таблиц; тест отдельно подтверждает fail-closed результат при отсутствующих столбцах.
- При отсутствии PostgreSQL/схемы/секретов административные API закрываются fail-closed; fallback на MemoryStore отсутствует.

## Сессии, CSRF и proxy

- Сессии хранятся в PostgreSQL через `connect-pg-simple`; `createTableIfMissing: false`.
- Cookie: `HttpOnly`, `SameSite=Strict`, `Secure` при `NODE_ENV=production`, срок действия 4 часа.
- Идентификатор сессии регенерируется после успешного входа; logout удаляет серверную сессию.
- Изменяющие административные запросы требуют CSRF-токен; login требует Origin, совпадающий с Host запроса.
- Вход администратора ограничен 8 попытками за 15 минут, создание заказа — 10 в час, загрузка чека — 5 в час. Счётчики общие между экземплярами, поскольку хранятся в PostgreSQL; при недоступности store запросы закрываются с HTTP 503, локального fallback нет.
- Значимые административные события записываются структурированно в `admin_audit`: результат, фиксированный код причины, request ID, тип/ID цели и хэш сессии. Пароли, cookies, токены, CSRF-секреты, содержимое чеков и произвольный текст ошибки не сохраняются. Таблица не объявляется append-only или защищённой от подделки.
- `TRUST_PROXY_HOPS` должен соответствовать реальной топологии proxy. Значение `1` в `.env.example` — пример, не подтверждение Render-настройки. Неправильное число hops может повлиять на определение IP и secure cookies; перед production подтвердите topology.
- TLS для удалённого PostgreSQL настроен с `rejectUnauthorized: true`; `PGSSL_CA` может задавать CA.

## PostgreSQL и миграции

Миграция `migrations/001_session_store_and_safe_admin.sql` создаёт базовые таблицы; `migrations/002_shared_rate_limits_and_audit.sql` добавляет общие счётчики лимитов и поля аудита. Обе миграции проверяются повторным запуском на изолированной PostgreSQL. Production миграции не запускались. Перед deployment проверьте 002 на отдельном клоне и подтвердите права DB-роли: SELECT/INSERT/UPDATE/DELETE для `rate_limit_counters`, INSERT для `admin_audit`. Используется уже существующий `DATABASE_URL`; Redis или новые переменные окружения не требуются. При недоступности общего хранилища лимитов запросы завершаются 503.

## Проверки CI

[Run #236](https://github.com/Beak67/zavaebatel-uc/actions/runs/38699952627) успешно выполнил `npm ci`, `node --check server.js && node --check public/admin.js && node --check public/storefront.js`, `npm test` и `npm audit --omit=dev` для application/test revision `003522133b0f8b8b23411e626f1cb10e0992275f`. CI использовал эфемерную PostgreSQL 16; команды выполнялись в GitHub Actions, не локально. Последующие изменения документации не меняют протестированный код/тесты. Это не production test.

Интеграционные тесты допускают только loopback/localhost и имя БД с суффиксом `_test`; guard защищает от случайной ошибки, но не от вручную настроенного локального туннеля к production. Тесты проверяют два независимых PostgreSQL-backed store, превышение login-лимита, истечение/reset счётчика, ошибки store, audit rows и секретные поля, идемпотентность миграций и safe mode при `SBP_ENABLED=true`.

Подробности и актуальные статусы PASS / FAIL / NOT VERIFIED описаны в [SECURITY_AUDIT.md](SECURITY_AUDIT.md).

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
