# ZAVAEBATEL UC — безопасный каталог PUBG Mobile UC

## Текущий режим

Приложение показывает каталог и рассчитанные сервером цены, если настроен Nexus API. **Оформление заказов, платёжные инструкции, загрузка чеков, подтверждение оплаты и выдача UC намеренно отключены в коде.** Изменение `SBP_ENABLED` не включает эти функции. Не переводите деньги и не используйте этот проект для реальных заказов.

- `POST /api/orders` и `POST /api/orders/:publicId/receipt` возвращают HTTP 503.
- `GET /api/payment-info` сообщает, что платежи отключены.
- Административные действия изменения статуса/подтверждения/выдачи возвращают HTTP 503.
- Защита выполняется на сервере, а не только скрытием кнопок.
- При несовместимой схеме БД readiness-проверка требует все необходимые столбцы и не должна считать приложение готовым.

## Локальная разработка и проверки

Требуется Node.js 20+ и npm. CI использует отдельный эфемерный PostgreSQL 16.

```sh
npm ci
node --check server.js
node --check public/admin.js
node --check public/storefront.js
npm test
npm audit --omit=dev
```

**Не запускайте интеграционные тесты против production.** `TEST_DATABASE_URL` должен указывать только на loopback/localhost и имя БД, оканчивающееся на `_test`; тест откажется стартовать с другим адресом. Этот guard снижает риск ошибки конфигурации, но не защищает от вручную настроенного локального туннеля к production. CI использует локальный эфемерный PostgreSQL.

[CI run #169](https://github.com/Beak67/zavaebatel-uc/actions/runs/38697515235) успешно проверил код/тесты revision `dcdec4de4959a2834a0aa7e1aa07aa64bb873371`: `npm ci` — PASS; syntax checks — PASS; `npm test` — 20 passed, 0 failed, 0 skipped; `npm audit --omit=dev` — 0 vulnerabilities в production dependencies. Тесты запускаются с `SBP_ENABLED=true`, проверяют блокировку заказов, чеков, платежей и административной выдачи, исполняют миграцию дважды на изолированной CI БД и проверяют отказ при несовместимой схеме. Это CI evidence, не production test. Последующие изменения только документации не меняют протестированный код/тесты.

## Конфигурация

Скопируйте `.env.example` в локальный `.env` только для разработки. Никогда не коммитьте реальные пароли, токены, connection strings или содержимое production environment variables.

Для административной сессии нужны PostgreSQL (`DATABASE_URL`), случайный `SESSION_SECRET` длиной не менее 32 символов и уникальный `ADMIN_PASSWORD` длиной не менее 20 символов. В production `TRUST_PROXY_HOPS` должен соответствовать фактической схеме reverse proxy; значение из шаблона нельзя считать подтверждённой конфигурацией Render. Схему БД применяйте после проверки и резервного копирования; `DB_AUTO_INIT=false` — рекомендуемый режим.

Nexus credentials нужны только для чтения каталога в текущем safe mode. Не используйте production credentials для тестирования и не записывайте токены в логи.

## База данных и миграции

Миграция `migrations/001_session_store_and_safe_admin.sql` использует транзакцию и идемпотентные `IF NOT EXISTS` операции. CI запускает её дважды на отдельной тестовой PostgreSQL БД. Это не подтверждает совместимость с production-схемой, реальные права DB-роли или наличие резервных копий.

## Security review

См. [SECURITY_AUDIT.md](SECURITY_AUDIT.md) для статусов PASS / FAIL / NOT VERIFIED, доказательств, плана backup/restore и блокеров. Production Render, production PostgreSQL, backup/restore и Nexus credentials/contract не проверялись. Не включайте бизнес-функции, не выполняйте merge/deploy и не объявляйте production readiness на основании одного зелёного CI.
