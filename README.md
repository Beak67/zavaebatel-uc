# ZAVAEBATEL UC — безопасный каталог PUBG Mobile UC

## Текущий режим

Приложение показывает каталог и рассчитанные сервером цены, если настроен Nexus API. **Оформление заказов, платёжные инструкции, загрузка чеков, подтверждение оплаты и выдача UC намеренно отключены в коде.** Изменение `SBP_ENABLED` не включает эти функции. Не переводите деньги и не используйте этот проект для реальных заказов.

- `POST /api/orders` и `POST /api/orders/:publicId/receipt` возвращают HTTP 503.
- `GET /api/payment-info` сообщает, что платежи отключены.
- Административные действия изменения статуса/подтверждения/выдачи возвращают HTTP 503.
- Админка доступна только при корректно настроенных PostgreSQL, сессиях и конфигурации; интерфейс не предоставляет рабочие действия по заказам.

## Локальная разработка и проверки

Требуется Node.js 20+ и npm. В CI используется отдельный эфемерный PostgreSQL; **не запускайте интеграционные тесты с production `DATABASE_URL`**.

```sh
npm ci
node --check server.js
node --check public/admin.js
node --check public/storefront.js
npm test
npm audit --omit=dev
```

Workflow `.github/workflows/test.yml` запускает проверки в Node.js 20 и PostgreSQL 16. Run [#114](https://github.com/Beak67/zavaebatel-uc/actions/runs/38694541262) успешно завершился на PR merge ref, содержащем branch head `317011b111d8be11defc67fb9adebe0e1b5402dc`: `npm ci`, синтаксические проверки, `npm test` и `npm audit --omit=dev` — success. В логах run #114 контейнер PostgreSQL сначала ожидал health status `healthy`, затем job продолжился; ошибки и провала на `Initialize containers` нет. После этого обновлён регрессионный тест: теперь он вызывает реальный Express error middleware через HTTP и запускает тесты с `SBP_ENABLED=true`. Эти последние изменения требуют отдельного CI-run; run #114 не подтверждает их.

## Конфигурация

Скопируйте `.env.example` в локальный `.env` только для разработки. Никогда не коммитьте реальные пароли, токены, connection strings или содержимое production environment variables.

Для административной сессии нужны PostgreSQL (`DATABASE_URL`), случайный `SESSION_SECRET` длиной не менее 32 символов и уникальный `ADMIN_PASSWORD` длиной не менее 20 символов. В production `TRUST_PROXY_HOPS` должен соответствовать фактической схеме reverse proxy; значение из шаблона нельзя считать подтверждённой конфигурацией Render. Схему БД применяйте отдельной миграцией после проверки и резервного копирования; `DB_AUTO_INIT=false` — рекомендуемый режим.

Nexus credentials нужны только для чтения каталога. Не запускайте запросы к реальному Nexus при тестировании и не записывайте токены в логи.

## База данных и миграции

Миграция `migrations/001_session_store_and_safe_admin.sql` создаёт недостающие таблицы и индексы и добавляет колонку `reviewed_by`; она не предназначена для автоматического применения к production. Сначала проверьте её на отдельной тестовой БД, сделайте резервную копию и согласуйте изменение с владельцем.

## Security review

См. [SECURITY_AUDIT.md](SECURITY_AUDIT.md) для объёма проверки, подтверждённых CI результатов, ограничений и оставшихся действий перед production. Production Render, production PostgreSQL и Nexus credentials в этом изменении не проверялись. Не включайте бизнес-функции и не выполняйте deploy на основании одного зелёного CI.
